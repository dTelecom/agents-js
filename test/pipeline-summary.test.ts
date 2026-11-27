import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import type { LLMPlugin, Message } from '../src/core/types';
import { MockSTT, MockTTS, MockAudioOutput } from './helpers/mock-providers';

const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../src/utils/logger', () => ({ createLogger: () => logs }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
const isSummary = (messages: Message[]) => !!messages[0].content?.startsWith('Summarize');

describe('Pipeline background summarization', () => {
  let pipeline: Pipeline;
  let stt: MockSTT;
  let output: MockAudioOutput;
  let tts: MockTTS;
  let errors: Error[];
  const releases: Array<() => void> = [];
  /** Lets the turn and its 800 ms audio drain finish. */
  const settle = () => vi.advanceTimersByTimeAsync(1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    vi.clearAllMocks();
    stt = new MockSTT(); output = new MockAudioOutput(); tts = new MockTTS(); errors = [];
  });
  afterEach(async () => {
    await pipeline?.stop();
    releases.splice(0).forEach(resolve => resolve());
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
  });

  /**
   * An LLM whose summaries wait for `release()` (or fail with `summaryError`); answers are
   * immediate. Records every request.
   */
  function summaryLLM(options: { summaryError?: Error } = {}) {
    const gate = deferred();
    releases.push(gate.resolve);
    const answers: Message[][] = [];
    const summaries: Array<{ messages: Message[]; signal?: AbortSignal }> = [];
    const llm: LLMPlugin = {
      async *chat(messages, signal) {
        if (isSummary(messages)) {
          summaries.push({ messages, signal });
          await gate.promise;
          if (options.summaryError) throw options.summaryError;
          yield { type: 'token', token: 'Summary of the earlier turns.' };
        } else {
          answers.push(messages);
          yield { type: 'token', token: 'Here is the answer to that.' };
        }
        yield { type: 'done' };
      },
    };
    return { llm, answers, summaries, release: gate.resolve };
  }

  function create(llm: LLMPlugin, extra = {}) {
    pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'Help.', maxContextTokens: 1, ...extra });
    pipeline.on('error', error => errors.push(error));
    pipeline.addParticipant('user');
    const context = pipeline.getContextManager();
    for (let i = 0; i < 6; i++) context.addUserTurn('user', `Earlier ${i}`);
    return context;
  }
  async function ask(text: string) {
    stt.streams[0].simulateTranscription(text, true);
    await settle();
  }
  const hasSummary = (messages: Message[]) => messages.some(m => m.content?.includes('Conversation summary'));

  it('starts the summary after the answer and issues the next answer without waiting for it', async () => {
    const { llm, answers, summaries, release } = summaryLLM();
    const context = create(llm);
    await ask('First');
    expect(answers).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    // The turn has ended (its signal was reset); the summary keeps running.
    expect(summaries[0].signal?.aborted).toBe(false);

    await ask('Second');
    expect(answers).toHaveLength(2);
    expect(answers[1].at(-1)).toEqual({ role: 'user', content: '[user]: Second' });
    expect(hasSummary(answers[1])).toBe(false);
    const latency = logs.info.mock.calls.map(args => args.join(' ')).find(line => line.startsWith('LATENCY "Second"'));
    expect(latency).toContain('Prepare=0ms');

    // Turns recorded while the summary ran survive its commit.
    release(); await vi.advanceTimersByTimeAsync(0);
    const messages = context.buildMessages();
    expect(hasSummary(messages)).toBe(true);
    expect(messages.map(m => m.content)).toContain('[user]: Second');
    expect(messages.at(-1)).toEqual({ role: 'assistant', content: 'Here is the answer to that.' });
    expect(tts.synthesizeCalls).toEqual(['Here is the answer to that.', 'Here is the answer to that.']);
    expect(errors).toEqual([]);
  });

  it('runs no concurrent summaries', async () => {
    const { llm, answers, summaries, release } = summaryLLM();
    create(llm);
    await ask('First');
    await ask('Second');
    await ask('Third');
    expect(answers).toHaveLength(3);
    expect(summaries).toHaveLength(1);
    release(); await vi.advanceTimersByTimeAsync(0);
    // The next turn may start a new summary once the first is committed.
    await ask('Fourth');
    expect(summaries).toHaveLength(2);
  });

  for (const error of [new Error('Provider unavailable'), new Error('OpenRouter response incomplete (length)')]) {
    it(`a failed summary leaves the turns and the answers intact: ${error.message}`, async () => {
      const { llm, answers, release } = summaryLLM({ summaryError: error });
      const context = create(llm);
      await ask('First');
      const before = context.buildMessages();
      release(); await vi.advanceTimersByTimeAsync(0);
      expect(context.buildMessages()).toEqual(before);
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('summary failed'), error);
      await ask('Second');
      expect(answers).toHaveLength(2);
      expect(tts.synthesizeCalls).toHaveLength(2);
      expect(errors).toEqual([]);
      expect(logs.error).not.toHaveBeenCalled();
    });
  }

  it('stop() cancels the summary and discards its late result', async () => {
    const { llm, summaries, release } = summaryLLM();
    const context = create(llm);
    await ask('First');
    const before = context.buildMessages();
    await pipeline.stop();
    expect(summaries[0].signal?.aborted).toBe(true);
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(context.buildMessages()).toEqual(before);
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it('a context reset discards a summary that finishes later', async () => {
    const { llm, release } = summaryLLM();
    const context = create(llm);
    await ask('First');
    context.reset();
    context.addUserTurn('user', 'After reset');
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(context.buildMessages()).toEqual([
      { role: 'system', content: 'Help.' },
      { role: 'user', content: '[user]: After reset' },
    ]);
  });

  it('long instructions with a short history start no summary', async () => {
    const { llm, answers, summaries } = summaryLLM();
    pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'x'.repeat(40_000), maxContextTokens: 5000 });
    pipeline.on('error', error => errors.push(error));
    pipeline.addParticipant('user');
    for (const text of ['One', 'Two', 'Three', 'Four']) await ask(text);
    expect(answers).toHaveLength(4);
    expect(summaries).toHaveLength(0);
  });

  it('also starts after say(), e.g. a greeting', async () => {
    const { llm, summaries } = summaryLLM();
    create(llm);
    const greeting = pipeline.say('Hello there, ask me anything.');
    await settle(); await greeting;
    expect(summaries).toHaveLength(1);
  });
});
