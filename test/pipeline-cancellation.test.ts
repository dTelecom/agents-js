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
function abortError() {
  return Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' });
}

describe('Pipeline cancellation ownership', () => {
  let pipeline: Pipeline;
  let stt: MockSTT;
  let output: MockAudioOutput;
  let tts: MockTTS;
  let errors: Error[];
  const releases: Array<() => void> = [];
  const gate = () => { const d = deferred(); releases.push(d.resolve); return d; };
  const flush = () => vi.advanceTimersByTimeAsync(0);

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
  function create(llm: LLMPlugin, extra = {}) {
    pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'Help.', ...extra });
    pipeline.on('error', error => errors.push(error));
    pipeline.addParticipant('user');
  }
  function question(text: string) { stt.streams[0].simulateTranscription(text, true); }

  it('cancels summarization before starting an obsolete response and preserves context until cleanup', async () => {
    const summaryGate = gate();
    let summarySignal: AbortSignal | undefined;
    let summaries = 0;
    const answers: string[] = [];
    create({ async *chat(messages, signal) {
      if (messages[0].content.startsWith('Summarize')) {
        if (++summaries === 1) {
          summarySignal = signal;
          yield { type: 'token', token: 'INCOMPLETE SUMMARY' };
          await summaryGate.promise;
          throw abortError();
        }
        yield { type: 'token', token: 'Valid summary.' };
      } else {
        answers.push(messages.at(-1)!.content);
        yield { type: 'token', token: 'The new answer is ready to be spoken.' };
      }
      yield { type: 'done' };
    } }, { maxContextTokens: 1 });
    const context = pipeline.getContextManager();
    for (let i = 0; i < 5; i++) context.addUserTurn('user', `Earlier ${i}`);
    question('Old question'); await flush();
    const before = context.buildMessages();
    question('New question'); await flush();
    expect(summarySignal?.aborted).toBe(true);
    expect(context.buildMessages()).toEqual(before);
    expect(answers).toEqual([]);
    summaryGate.resolve(); await flush();
    expect(answers).toEqual(['[user]: New question']);
    expect(context.buildMessages().some(m => m.content.includes('INCOMPLETE SUMMARY'))).toBe(false);
    expect(tts.synthesizeCalls).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  for (const kind of ['response', 'greeting'] as const) {
    it(`preserves interruption during ${kind} warmup`, async () => {
      const warmup = gate(); const answers: string[] = [];
      if (kind === 'greeting') Object.assign(output, { whenReady: warmup.promise });
      create({ warmup: () => warmup.promise, async *chat(messages) {
        answers.push(messages.at(-1)!.content);
        yield { type: 'token', token: 'Only the new response should be spoken.' };
      } });
      if (kind === 'greeting') {
        // say() waits for audio readiness, independently of LLM warmup.
        void pipeline.say('An obsolete greeting.');
      } else question('Old question');
      await flush(); question('New question'); await flush();
      warmup.resolve(); await flush();
      expect(answers).toEqual(['[user]: New question']);
      expect(tts.synthesizeCalls.every(text => !text.includes('obsolete'))).toBe(true);
      expect(errors).toEqual([]);
    });
  }

  it('treats APIUserAbortError as cancellation, cleans up both tasks, then starts the queued turn', async () => {
    const cleanup = gate(); let signal: AbortSignal | undefined; let calls = 0;
    const lifecycle: string[] = [];
    vi.spyOn(output, 'beginResponse').mockImplementation(() => { lifecycle.push('begin'); });
    vi.spyOn(output, 'endResponse').mockImplementation(() => { lifecycle.push('end'); });
    create({ async *chat(_messages, currentSignal) {
      if (++calls === 1) {
        signal = currentSignal;
        await cleanup.promise;
        throw abortError();
      }
      yield { type: 'token', token: 'The queued answer is ready to be spoken.' };
    } });
    question('Old'); await flush(); question('New'); await flush();
    expect(signal?.aborted).toBe(true);
    expect(calls).toBe(1);
    cleanup.resolve(); await flush();
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
    expect(lifecycle).toEqual(['begin', 'end', 'begin', 'end']);
    expect(logs.error).not.toHaveBeenCalled();
  });

  for (const error of [new Error('Provider unavailable'), abortError()]) {
    it(`reports a genuine failure without a cancelled signal: ${error.name}`, async () => {
      create({ async *chat() { throw error; } });
      question('Question'); await flush();
      expect(errors).toEqual([error]);
      expect(pipeline.processing).toBe(false);
    });
  }

  it('stop cancels warmup and drops pending turns', async () => {
    const warmup = gate(); const answers: Message[][] = [];
    create({ warmup: () => warmup.promise, async *chat(messages) {
      answers.push(messages); yield { type: 'token', token: 'Must not speak after stop.' };
    } });
    question('Old'); await flush(); question('New'); await flush();
    await pipeline.stop(); warmup.resolve(); await flush();
    expect(answers).toEqual([]);
    expect(tts.synthesizeCalls).toEqual([]);
    expect(pipeline.processing).toBe(false);
  });

  it('cancels waiting for memory search and ignores its late result', async () => {
    const search = gate(); const answers: string[] = []; let searches = 0;
    create({ async *chat(messages) {
      answers.push(messages.at(-1)!.content);
      yield { type: 'token', token: 'Only the latest answer should be spoken.' };
    } }, { memory: {
      storeTurn() {},
      async searchRelevant() { if (++searches === 1) await search.promise; return 'Memory'; },
    } });
    question('Old'); await flush(); question('New'); await flush();
    expect(answers).toEqual(['[user]: New']);
    search.resolve(); await flush();
    expect(answers).toEqual(['[user]: New']);
    expect(errors).toEqual([]);
  });

  it('reports queue wait separately from LLM generation time', async () => {
    const cleanup = gate(); let calls = 0;
    create({ async *chat() {
      if (++calls === 1) { await cleanup.promise; throw abortError(); }
      await new Promise(resolve => setTimeout(resolve, 200));
      yield { type: 'token', token: 'The queued response has now completed.' };
    } });
    await vi.advanceTimersByTimeAsync(10);
    question('Old'); await flush();
    await vi.advanceTimersByTimeAsync(100);
    question('New'); await flush();
    await vi.advanceTimersByTimeAsync(1500);
    cleanup.resolve(); await flush();
    await vi.advanceTimersByTimeAsync(200);
    const line = logs.info.mock.calls.map(args => args.join(' ')).find(text => text.startsWith('LATENCY "New"'));
    expect(line).toContain('Queue=1500ms Prepare=0ms LLM=200ms (TTFT=200ms)');
    expect(errors).toEqual([]);
  });
});
