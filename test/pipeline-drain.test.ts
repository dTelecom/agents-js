import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import type { TTSPlugin } from '../src/core/types';
import { MockSTT, MockLLM, MockTTS, MockAudioOutput } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Pipeline audio drain', () => {
  let stt: MockSTT;
  let llm: MockLLM;
  let output: MockAudioOutput;
  let pipeline: Pipeline;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stt = new MockSTT();
    llm = new MockLLM('This is a complete response that is ready to be spoken.');
    output = new MockAudioOutput();
  });

  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await pipeline?.stop();
    vi.useRealTimers();
  });

  function create(tts: TTSPlugin | undefined) {
    pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'Be helpful.' });
    pipeline.addParticipant('user');
  }

  function question(text: string) {
    stt.streams[0].simulateTranscription(text, true);
  }

  async function start(kind: 'response' | 'greeting') {
    if (kind === 'response') question('Hello.');
    else void pipeline.say('Hello, this is the greeting.');
    await vi.advanceTimersByTimeAsync(0);
  }

  for (const kind of ['response', 'greeting'] as const) {
    for (const firstAudio of [false, true]) {
      it(`${kind}: cancellation ${firstAudio ? 'during playback' : 'before first audio'} releases the queued turn after provider cleanup, without 800 ms`, async () => {
        const cleanup = deferred();
        let firstClosed = false;
        let calls = 0;
        const tts: TTSPlugin = {
          sequential: true,
          async *synthesize(_text, signal) {
            calls++;
            if (calls === 1) {
              try {
                if (firstAudio) yield Buffer.from([1, 0]);
                await new Promise<void>((resolve) => {
                  if (signal?.aborted) resolve();
                  else signal?.addEventListener('abort', () => resolve(), { once: true });
                });
              } finally {
                // Simulate a provider draining/acknowledging its cancellation.
                await cleanup.promise;
                firstClosed = true;
              }
            } else {
              expect(firstClosed).toBe(true);
              yield Buffer.from([2, 0]);
            }
          },
        };
        create(tts);
        await start(kind);
        expect(calls).toBe(1);
        expect(output.writtenBuffers).toHaveLength(firstAudio ? 1 : 0);
        const previousLlmCalls = llm.calls.length;

        question('What are you doing?');
        await vi.advanceTimersByTimeAsync(0);
        expect(output.flushed).toBe(true);
        expect(llm.calls).toHaveLength(previousLlmCalls);
        expect(calls).toBe(1);

        cleanup.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(firstClosed).toBe(true);
        expect(llm.calls).toHaveLength(previousLlmCalls + 1);
        expect(calls).toBe(2);
        expect(output.writtenBuffers.at(-1)).toEqual(Buffer.from([2, 0]));
        expect(output.writtenBuffers).toHaveLength(firstAudio ? 2 : 1);
      });
    }

    it(`${kind}: a new final interrupts a drain already in progress`, async () => {
      create(new MockTTS());
      await start(kind);
      expect(pipeline.processing).toBe(true);
      expect(pipeline.agentState).toBe('speaking');
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      const previousLlmCalls = llm.calls.length;

      question('Another question.');
      await vi.advanceTimersByTimeAsync(0);
      expect(llm.calls).toHaveLength(previousLlmCalls + 1);
      // Only the new response's drain remains. The old timer cannot reset it.
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(700);
      expect(pipeline.processing).toBe(true);
      expect(pipeline.agentState).toBe('speaking');
      await vi.advanceTimersByTimeAsync(100);
      expect(pipeline.processing).toBe(false);
      expect(pipeline.agentState).toBe('idle');
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`${kind}: completed speech retains its 800 ms UI drain`, async () => {
      create(new MockTTS());
      await start(kind);
      expect(output.writtenBuffers.length).toBeGreaterThan(0);
      expect(pipeline.agentState).toBe('speaking');
      await vi.advanceTimersByTimeAsync(799);
      expect(pipeline.processing).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(pipeline.processing).toBe(false);
      expect(pipeline.agentState).toBe('idle');
      expect(vi.getTimerCount()).toBe(0);
    });

    for (const mode of ['no provider', 'empty output', 'empty chunks'] as const) {
      it(`${kind}: ${mode} does not incur an audio drain`, async () => {
        create(mode === 'no provider' ? undefined : mode === 'empty output' ? new MockTTS(0, 0) : {
          async *synthesize() { yield Buffer.alloc(0); },
        });
        await start(kind);
        expect(output.writtenBuffers).toHaveLength(0);
        expect(pipeline.processing).toBe(false);
        expect(pipeline.agentState).toBe('idle');
        expect(vi.getTimerCount()).toBe(0);
      });
    }
  }
});
