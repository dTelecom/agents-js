import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';
import type { LLMChatOptions, LLMChunk, LLMPlugin, Message, ToolCallResult, ToolDefinition, TurnMetrics } from '../src/core/types';
import { MockSTT, MockTTS, MockAudioOutput } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
}));

const weather: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Current weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  },
};

type Step = { text?: string; calls?: ToolCallResult[] };

/** Answers each chat call from a script; records the messages and options of every call. */
class ScriptedLLM implements LLMPlugin {
  readonly calls: Array<{ messages: Message[]; options?: LLMChatOptions }> = [];
  constructor(private readonly script: (call: number, options?: LLMChatOptions) => Step) {}

  async *chat(messages: Message[], signal?: AbortSignal, options?: LLMChatOptions): AsyncGenerator<LLMChunk> {
    this.calls.push({ messages: structuredClone(messages), options });
    const step = this.script(this.calls.length - 1, options);
    for (const word of (step.text ?? '').split(' ').filter(Boolean)) {
      if (signal?.aborted) return;
      yield { type: 'token', token: ` ${word}` };
    }
    for (const call of step.calls ?? []) yield { type: 'tool_call', toolCall: call };
    yield { type: 'done' };
  }
}

const call = (id: string, args = '{"city":"Paris"}'): ToolCallResult => ({ id, name: 'get_weather', arguments: args });

describe('tool results', () => {
  let stt: MockSTT;
  let tts: MockTTS;
  let audioOutput: MockAudioOutput;
  const pipelines: Pipeline[] = [];

  beforeEach(() => {
    stt = new MockSTT();
    tts = new MockTTS();
    audioOutput = new MockAudioOutput();
  });
  afterEach(async () => {
    for (const p of pipelines.splice(0)) await p.stop();
  });

  function start(llm: LLMPlugin, tools: unknown[]) {
    const pipeline = new Pipeline({ stt, llm, tts, audioOutput: audioOutput as any, instructions: 'Be brief.', tools: tools as any });
    pipelines.push(pipeline);
    pipeline.addParticipant('user1');
    return pipeline;
  }
  const next = <T>(pipeline: Pipeline, event: string) => new Promise<T>((resolve) => pipeline.once(event, resolve));

  it('runs the handler, sends the result back and speaks the answer', async () => {
    const llm = new ScriptedLLM((n) => n === 0
      ? { text: 'Let me check.', calls: [call('call_1')] }
      : { text: 'It is sunny in Paris.' });
    const handler = vi.fn(async (args: { city: string }, _context: { signal: AbortSignal }) => ({ city: args.city, sky: 'sunny' }));
    const pipeline = start(llm, [{ definition: weather, handler }]);
    const toolCalls: ToolCallResult[] = [];
    pipeline.on('toolCall', (c) => toolCalls.push(c));
    const metrics = next<TurnMetrics>(pipeline, 'metrics');
    const response = next<string>(pipeline, 'response');

    stt.streams[0].simulateTranscription('What is the weather in Paris?', true);

    expect(await response).toBe('Let me check. It is sunny in Paris.');
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).toEqual({ city: 'Paris' });
    expect(handler.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal);
    expect(toolCalls).toEqual([call('call_1')]);

    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[0].options?.tools).toEqual([weather]);
    expect(llm.calls[1].messages.slice(-2)).toEqual([
      { role: 'assistant', content: 'Let me check.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"city":"Paris","sky":"sunny"}' },
    ]);
    expect(tts.synthesizeCalls.join(' ')).toContain('Let me check.');
    expect(tts.synthesizeCalls.join(' ')).toContain('It is sunny in Paris.');

    const m = await metrics;
    expect(m.toolCalls).toBe(1);
    expect(m.speaker).toBe('user1');
    expect(m.llmMs).not.toBeNull();

    // The context keeps the call with its result, then the answer.
    const context = pipeline.getContextManager().buildMessages();
    expect(context.slice(-3).map((msg) => msg.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(context[context.length - 1]).toEqual({ role: 'assistant', content: 'It is sunny in Paris.' });
  });

  it('keeps the old behaviour for a tool without a handler', async () => {
    const llm = new ScriptedLLM(() => ({ calls: [call('call_1')] }));
    const pipeline = start(llm, [weather]);
    const toolCall = next<ToolCallResult>(pipeline, 'toolCall');
    const metrics = next<TurnMetrics>(pipeline, 'metrics');
    stt.streams[0].simulateTranscription('Weather?', true);
    expect(await toolCall).toEqual(call('call_1'));
    expect((await metrics).toolCalls).toBe(1);
    expect(llm.calls).toHaveLength(1);
    expect(pipeline.getContextManager().buildMessages().some((m) => m.role === 'tool')).toBe(false);
  });

  it('sends handler errors, bad arguments and timeouts back to the model', async () => {
    const results: string[] = [];
    const llm = new ScriptedLLM((n) => {
      if (n === 0) return { calls: [call('a'), call('b', 'not json'), call('c', '{"city":"Slow"}')] };
      return { text: 'Sorry, that failed.' };
    });
    const handler = vi.fn(async (args: { city: string }) => {
      if (args.city === 'Paris') throw new Error('service down');
      return new Promise(() => {}); // never settles
    });
    const pipeline = start(llm, [{ definition: weather, handler, timeoutMs: 50 }]);
    const response = next<string>(pipeline, 'response');
    stt.streams[0].simulateTranscription('Weather?', true);
    expect(await response).toBe('Sorry, that failed.');
    for (const msg of llm.calls[1].messages) if (msg.role === 'tool') results.push(msg.content);
    expect(results).toEqual([
      '{"error":"service down"}',
      '{"error":"Arguments are not valid JSON"}',
      '{"error":"Tool timed out after 50 ms"}',
    ]);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('asks for a text answer after three tool rounds', async () => {
    const llm = new ScriptedLLM((n, options) => options?.toolChoice === 'none'
      ? { text: 'Here is what I found.' }
      : { calls: [call(`call_${n}`)] });
    const handler = vi.fn(async () => 'ok');
    const pipeline = start(llm, [{ definition: weather, handler }]);
    const response = next<string>(pipeline, 'response');
    stt.streams[0].simulateTranscription('Keep checking', true);
    expect(await response).toBe('Here is what I found.');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(llm.calls.map((c) => c.options?.toolChoice)).toEqual([undefined, undefined, undefined, 'none']);
  });

  it('aborts a running handler on barge-in', async () => {
    let handlerSignal: AbortSignal | undefined;
    const started = new Promise<void>((resolve) => {
      const handler = (_args: unknown, { signal }: { signal: AbortSignal }) => {
        handlerSignal = signal;
        resolve();
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
      };
      const llm = new ScriptedLLM((n) => n === 0 ? { calls: [call('call_1')] } : { text: 'Next answer here.' });
      start(llm, [{ definition: weather, handler }]);
      stt.streams[0].simulateTranscription('Weather?', true);
    });
    await started;
    stt.streams[0].simulateTranscription('Never mind', true);
    await vi.waitFor(() => expect(handlerSignal?.aborted).toBe(true));
  });
});

describe('metrics', () => {
  it('reports per-turn latency for a plain reply', async () => {
    const stt = new MockSTT();
    const llm = new ScriptedLLM(() => ({ text: 'Hello there, nice to meet you.' }));
    const pipeline = new Pipeline({ stt, llm, tts: new MockTTS(), audioOutput: new MockAudioOutput() as any, instructions: 'x' });
    pipeline.addParticipant('user1');
    const metrics = new Promise<TurnMetrics>((resolve) => pipeline.once('metrics', resolve));
    stt.streams[0].simulateTranscription('Hi', true);
    const m = await metrics;
    expect(m).toMatchObject({ speaker: 'user1', toolCalls: 0, toolMs: 0 });
    for (const key of ['ttftMs', 'llmMs', 'ttsMs', 'overallMs'] as const) expect(typeof m[key]).toBe('number');
    expect(Number.isInteger(m.queueMs)).toBe(true);
    await pipeline.stop();
  });
});

describe('providers', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('send tool_choice only with tools', async () => {
    const fetch = vi.fn(async () => new Response('data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetch);
    const llm = new OpenRouterLLM({ apiKey: 'test', model: 'm' });
    for await (const _ of llm.chat([], undefined, { tools: [weather], toolChoice: 'none' })) { /* consume */ }
    for await (const _ of llm.chat([], undefined, { toolChoice: 'none' })) { /* consume */ }
    const bodies = fetch.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].tool_choice).toBe('none');
    expect(bodies[0].tools).toEqual([weather]);
    expect(bodies[1]).not.toHaveProperty('tool_choice');
  });
});
