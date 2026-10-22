import { once } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { DtelecomSTT, type DtelecomSTTOptions } from '../src/providers/dtelecom-stt';
import { Pipeline } from '../src/core/pipeline';
import type { TranscriptionResult } from '../src/core/types';
import { MockLLM, MockAudioOutput } from './helpers/mock-providers';

// Default transport is in-memory so protocol/pipeline controls run without socket
// permissions. Set DTELECOM_TEST_REAL_WS=1 to run these same cases over loopback.
vi.mock('ws', async (importOriginal) => {
  if (process.env.DTELECOM_TEST_REAL_WS === '1') return importOriginal();
  const { EventEmitter } = await import('events');
  let server: any;
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    peer!: Socket;
    constructor(url?: string) {
      super();
      if (url) queueMicrotask(() => {
        const peer = new Socket();
        this.peer = peer;
        peer.peer = this;
        server.clients.add(peer);
        server.emit('connection', peer, { url: new URL(url).pathname + new URL(url).search });
        this.emit('open');
      });
    }
    send(data: string | Buffer) {
      queueMicrotask(() => {
        if (this.peer.readyState === 1) this.peer.emit('message', Buffer.from(data), Buffer.isBuffer(data));
      });
    }
    close() {
      if (this.readyState !== 1) return;
      this.readyState = this.peer.readyState = 3;
      queueMicrotask(() => {
        this.emit('close', 1000, Buffer.alloc(0));
        this.peer.emit('close', 1000, Buffer.alloc(0));
      });
    }
    terminate() { this.close(); }
  }
  class Server extends EventEmitter {
    clients = new Set<Socket>();
    constructor() { super(); server = this; queueMicrotask(() => this.emit('listening')); }
    address() { return { port: 12345 }; }
    close(cb: () => void) { cb(); }
  }
  return { default: Socket, WebSocket: Socket, WebSocketServer: Server };
});

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: Partial<DtelecomSTTOptions> = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  cleanups.push(async () => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test address');
  const messages: any[] = [];
  const sockets: WebSocket[] = [];
  const paths: string[] = [];
  server.on('connection', (ws, request) => {
    sockets.push(ws);
    paths.push(request.url!);
    ws.on('message', (data, binary) => {
      messages.push(binary ? Buffer.from(data as Buffer) : JSON.parse(data.toString()));
    });
  });
  const stt = new DtelecomSTT({
    serverUrl: `http://127.0.0.1:${address.port}/v1/stream?trace=1`,
    sessionKey: 'test-only', language: 'en', ...options,
  });
  function stream() {
    const stream = stt.createStream();
    cleanups.push(() => stream.close());
    return stream;
  }
  return { stt, stream, messages, sockets, paths,
    send: (message: object) => sockets.at(-1)!.send(JSON.stringify(message)) };
}

const partial = { type: 'transcription_partial', text: 'Привет', language: 'ru',
  is_final: false, provisional: true, replace_previous: true, utterance_id: 'u1', revision: 1, window_start_seconds: 0 };

it('keeps the default config and final transcript shape, ignores unsolicited partials', async () => {
  const f = await fixture();
  const stream = f.stream();
  const results: TranscriptionResult[] = [];
  stream.on('transcription', result => results.push(result));
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]).toEqual({ type: 'config', language: 'en', session_key: 'test-only' });
  expect(f.paths).toEqual(['/v1/stream?trace=1']);
  f.send(partial);
  f.send({ type: 'transcription', text: 'Hello.', language: 'en', is_final: true, latency_ms: 42 });
  await vi.waitFor(() => expect(results).toHaveLength(1));
  expect(results[0]).toEqual({ text: 'Hello.', language: 'en', isFinal: true, sttDuration: 42 });
});

it.each([true, false])('passes explicit feature flags (%s), preserving them across language changes and reconnects', async enabled => {
  const f = await fixture({ partials: enabled, smartTurn: enabled });
  const stream = f.stream();
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  expect(f.messages[0]).toMatchObject({ partials: enabled, smart_turn: enabled });
  stream.setLanguage!('ru');
  await vi.waitFor(() => expect(f.messages).toHaveLength(2));
  expect(f.messages[1]).toEqual({ type: 'config', language: 'ru', partials: enabled, smart_turn: enabled });
  f.sockets[0].close();
  await vi.waitFor(() => expect(f.messages).toHaveLength(3), { timeout: 2000 });
  expect(f.messages[2]).toMatchObject({ language: 'ru', partials: enabled, smart_turn: enabled, session_key: 'test-only' });
});

it.each(['active', 'acoustic_fallback', undefined])('reports Smart Turn readiness honestly: %s', async mode => {
  const f = await fixture({ smartTurn: true });
  const stream = f.stream();
  const ready = vi.fn();
  stream.on('ready', ready);
  stream.sendAudio(Buffer.from([1, 0]));
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.send({ type: 'ready', language: 'en', client_id: 'test', ...(mode ? { smart_turn: mode } : {}) });
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(ready.mock.calls[0][0]).toEqual({ clientId: 'test', language: 'en', ...(mode ? { smartTurn: mode } : {}) });
  await vi.waitFor(() => expect(f.messages[1]).toEqual(Buffer.from([1, 0])));
});

it('surfaces the missing-model server error instead of claiming Smart Turn is active', async () => {
  const f = await fixture({ smartTurn: true });
  const stream = f.stream();
  const error = vi.fn();
  const ready = vi.fn();
  stream.on('error', error).on('ready', ready);
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.send({ type: 'error', error: 'invalid_config', message: 'smart_turn requires an enabled server model' });
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  expect(error.mock.calls[0][0].message).toContain('enabled server model');
  expect(ready).not.toHaveBeenCalled();
});

it('forwards replaceable partials and clear events without starting an LLM turn until the final', async () => {
  const f = await fixture({ partials: true, smartTurn: true });
  const llm = new MockLLM('A complete answer.');
  const output = new MockAudioOutput();
  const pipeline = new Pipeline({ stt: f.stt, llm, audioOutput: output as any, instructions: 'Test.' });
  cleanups.push(() => pipeline.stop());
  const provisional = vi.fn();
  const ended = vi.fn();
  const readiness = vi.fn();
  const transcript = vi.fn();
  pipeline.on('transcription_partial', provisional).on('partial_end', ended)
    .on('stt_ready', readiness).on('transcription', transcript);
  pipeline.addParticipant('speaker');
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.send({ type: 'ready', language: 'ru', smart_turn: 'active' });
  f.send(partial);
  f.send({ ...partial, text: 'Привет мир', revision: 2, window_start_seconds: 0.5 });
  f.send({ type: 'partial_end', utterance_id: 'u1', reason: 'finalizing' });
  await vi.waitFor(() => expect(ended).toHaveBeenCalledOnce());
  expect(provisional).toHaveBeenCalledTimes(2);
  expect(provisional.mock.calls[1][0]).toMatchObject({ text: 'Привет мир', isFinal: false,
    revision: 2, utteranceId: 'u1', windowStartSeconds: 0.5, provisional: true, replacePrevious: true, speaker: 'speaker' });
  expect(ended.mock.calls[0][0]).toEqual({ utteranceId: 'u1', reason: 'finalizing', speaker: 'speaker' });
  expect(readiness.mock.calls[0][0]).toMatchObject({ smartTurn: 'active', speaker: 'speaker' });
  expect(llm.calls).toHaveLength(0);
  f.send({ type: 'transcription', text: 'Привет мир.', language: 'ru', is_final: true, latency_ms: 10, utterance_id: 'u1' });
  await vi.waitFor(() => expect(llm.calls).toHaveLength(1));
  expect(transcript.mock.calls.at(-1)![0]).toMatchObject({ text: 'Привет мир.', isFinal: true, utteranceId: 'u1', speaker: 'speaker' });
});

it.each(['discarded', 'replaced', 'reconfigured'])('forwards partial_end reason %s', async reason => {
  const f = await fixture({ partials: true });
  const stream = f.stream();
  const ended = vi.fn();
  stream.on('partial_end', ended);
  await vi.waitFor(() => expect(f.messages).toHaveLength(1));
  f.send({ type: 'partial_end', utterance_id: 'u1', reason });
  await vi.waitFor(() => expect(ended).toHaveBeenCalledWith({ utteranceId: 'u1', reason }));
});
