import { once } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { Pipeline } from '../src/core/pipeline';
import { DtelecomTTS } from '../src/providers/dtelecom-tts';
import { MockSTT, MockLLM, MockAudioOutput } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Pipeline with the real dTelecom TTS transport', () => {
  it.each([false, true])('waits for cancellation acknowledgement before reusing the socket (first audio: %s)', async (firstAudio) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const firstRequest = deferred();
    const clearRequest = deferred();
    const allowClear = deferred();
    const secondRequest = deferred();
    const wire: string[] = [];
    let requests = 0;
    server.on('connection', (ws) => {
      ws.on('message', async (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'clear') {
          wire.push('clear');
          clearRequest.resolve();
          await allowClear.promise;
          if (ws.readyState === 1) {
            // An already-in-flight old frame must never become new speech.
            ws.send(Buffer.from([9, 0]));
            ws.send(JSON.stringify({ type: 'done' }));
            ws.send(JSON.stringify({ type: 'cleared' }));
            wire.push('cleared');
          }
        } else if (message.text) {
          requests++;
          wire.push(`text-${requests}`);
          if (requests === 1) {
            if (firstAudio) ws.send(Buffer.from([1, 0]));
            firstRequest.resolve();
          } else {
            ws.send(Buffer.from([2, 0]));
            ws.send(JSON.stringify({ type: 'done' }));
            secondRequest.resolve();
          }
        }
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const tts = new DtelecomTTS({
      serverUrl: `http://127.0.0.1:${address.port}`, sessionKey: 'test-only',
      voices: { en: { voice: 'M5', langCode: 'en' } }, defaultLanguage: 'en',
    });
    const stt = new MockSTT();
    const llm = new MockLLM('Here is a complete response that is ready to be spoken.');
    const output = new MockAudioOutput();
    const pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'Be helpful.' });
    try {
      pipeline.addParticipant('user');
      stt.streams[0].simulateTranscription('Hello.', true);
      await firstRequest.promise;
      if (firstAudio) await vi.waitFor(() => expect(output.writtenBuffers).toHaveLength(1));
      stt.streams[0].simulateTranscription('What are you doing?', true);
      await clearRequest.promise;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(llm.calls).toHaveLength(1);
      expect(requests).toBe(1);
      const acknowledgedAt = performance.now();
      allowClear.resolve();
      await secondRequest.promise;
      const nextRequestMs = performance.now() - acknowledgedAt;
      console.info(`After clear acknowledgement: next request in ${nextRequestMs.toFixed(1)} ms (first audio: ${firstAudio})`);
      expect(nextRequestMs).toBeLessThan(400);
      await vi.waitFor(() => expect(output.writtenBuffers.at(-1)).toEqual(Buffer.from([2, 0])));
      expect(wire).toEqual(['text-1', 'clear', 'cleared', 'text-2']);
      expect(output.writtenBuffers).toEqual(firstAudio
        ? [Buffer.from([1, 0]), Buffer.from([2, 0])]
        : [Buffer.from([2, 0])]);
      await vi.waitFor(() => expect(pipeline.processing).toBe(false), { timeout: 1500 });
    } finally {
      allowClear.resolve();
      await pipeline.stop();
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each(['disconnect', 'client close', 'timeout'] as const)('cancellation cannot hang on %s; next request reconnects', async (mode) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const firstRequest = deferred();
    const clearRequest = deferred();
    let connections = 0;
    server.on('connection', (ws) => {
      connections++;
      const firstConnection = connections === 1;
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'clear') {
          clearRequest.resolve();
          if (mode === 'disconnect') ws.close();
          // The other cases deliberately never acknowledge cancellation.
        } else if (message.text) {
          if (firstConnection) firstRequest.resolve();
          else {
            ws.send(Buffer.from([2, 0]));
            ws.send(JSON.stringify({ type: 'done' }));
          }
        }
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const tts = new DtelecomTTS({
      serverUrl: `http://127.0.0.1:${address.port}`, sessionKey: 'test-only',
      voices: { en: { voice: 'M5', langCode: 'en' } },
    });
    try {
      const controller = new AbortController();
      const stream = tts.synthesize('First request.', controller.signal);
      const first = stream.next();
      await firstRequest.promise;
      if (mode === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      controller.abort();
      await clearRequest.promise;
      if (mode === 'client close') tts.close();
      if (mode === 'timeout') {
        await vi.advanceTimersByTimeAsync(5000);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      }
      expect(await first).toEqual({ done: true, value: undefined });
      const chunks = [];
      for await (const chunk of tts.synthesize('Next request.')) chunks.push(chunk);
      expect(chunks).toEqual([Buffer.from([2, 0])]);
      expect(connections).toBe(2);
    } finally {
      vi.useRealTimers();
      tts.close();
      for (const ws of server.clients) ws.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
