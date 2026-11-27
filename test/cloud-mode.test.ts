import { once } from 'events';
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { CloudClient } from '@dtelecom/server-sdk-js';
import { CloudSpeechSession } from '../src/providers/cloud-speech-session';
import { DtelecomSTT } from '../src/providers/dtelecom-stt';
import { DtelecomTTS } from '../src/providers/dtelecom-tts';
import { RoomConnection } from '../src/room/room-connection';
import { VoiceAgent } from '../src/core/voice-agent';
import { MockLLM, MockSTT, MockTTS } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

const connects: Array<{ url: string; token: string; fallbackUrls?: string[] }> = [];
const tokenUpdates: Array<{ token: string; fallbackUrls?: string[] }> = [];
vi.mock('@dtelecom/server-sdk-node', () => ({
  Room: class {
    remoteParticipants = new Map();
    localParticipant = { async publishTrack() {}, async unpublishTrack() {} };
    on() {}
    async connect(url: string, token: string, options: { fallbackUrls?: string[] }) {
      connects.push({ url, token, fallbackUrls: options.fallbackUrls });
    }
    updateConnectionToken(token: string, fallbackUrls?: string[]) { tokenUpdates.push({ token, fallbackUrls }); }
    async disconnect() {}
  },
  LocalAudioTrack: { createAudioTrack: () => ({}) },
  AudioSource: class { ready = true; async captureFrame() {} flush() {} destroy() {} },
  AudioFrame: class { constructor(..._args: unknown[]) {} },
  TrackSource: { MICROPHONE: 1 },
}));

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A cloud that records calls; sessions point at `serverUrl` and expire after `ttlMs`; the agent's
 * token lasts `tokenTtlMs`.
 */
function fakeCloud(serverUrl = 'https://speech.example', ttlMs = 10 * 60_000, tokenTtlMs = 2 * 3_600_000) {
  const calls: Array<[string, any]> = [];
  let n = 0;
  const session = (kind: string, options: any) => {
    calls.push([`${kind}.createSession`, options]);
    n += 1;
    return { sessionId: `${kind}-${n}`, token: `${kind}-key-${n}`, serverUrl, expiresAt: new Date(Date.now() + ttlMs) };
  };
  const cloud = {
    stt: {
      createSession: vi.fn(async (o: any) => session('stt', o)),
      extend: vi.fn(async (id: string, seconds: number) => {
        calls.push(['stt.extend', { id, seconds }]);
        return { token: `${id}-ext-${calls.length}`, expiresAt: new Date(Date.now() + ttlMs) };
      }),
    },
    tts: {
      createSession: vi.fn(async (o: any) => session('tts', o)),
      extend: vi.fn(async (id: string, characters: number) => {
        calls.push(['tts.extend', { id, characters }]);
        const total = calls.filter(([name]) => name === 'tts.extend')
          .reduce((sum, [, c]) => sum + c.characters, 2000);
        return { token: `${id}-ext-${calls.length}`, maxCharacters: total, expiresAt: new Date(Date.now() + ttlMs) };
      }),
    },
    createToken: vi.fn(async (o: any) => {
      calls.push(['createToken', o]);
      return { token: 'agent-token', wsUrl: 'wss://node.example', fallbackUrls: ['wss://node.example', 'wss://b.example'], sessionId: 'webrtc-1', expiresAt: new Date(Date.now() + tokenTtlMs) };
    }),
    extendToken: vi.fn(async (id: string, seconds: number) => {
      calls.push(['extendToken', { id, seconds }]);
      return { token: `agent-token-${calls.length}`, wsUrl: 'wss://node.example', fallbackUrls: ['wss://node.example', 'wss://c.example'], expiresAt: new Date(Date.now() + seconds * 1000) };
    }),
  };
  return { cloud: cloud as unknown as CloudClient, calls };
}

/** A loopback speech server that records JSON messages per connection. */
async function speechServer(onMessage?: (ws: any, message: any) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const connections: any[][] = [];
  server.on('connection', (ws) => {
    const messages: any[] = [];
    connections.push(messages);
    ws.on('message', (raw, binary) => {
      if (binary) return;
      const message = JSON.parse(raw.toString());
      messages.push(message);
      onMessage?.(ws, message);
    });
  });
  cleanups.push(async () => {
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const { port } = server.address() as AddressInfo;
  /** Drops every open connection; the server keeps listening. */
  const drop = () => { for (const ws of server.clients) ws.terminate(); };
  return { url: `http://127.0.0.1:${port}`, connections, drop };
}

describe('CloudSpeechSession', () => {
  it('extends STT before the held minutes run out and hands over the new key', async () => {
    vi.useFakeTimers();
    const { cloud, calls } = fakeCloud();
    const keys: string[] = [];
    const session = new CloudSpeechSession({
      kind: 'stt', cloud, language: 'en', onExtended: (key) => keys.push(key), onError: () => {},
    });
    await session.open('webrtc-1');
    expect(calls[0]).toEqual(['stt.createSession', { duration: 600, language: 'en', webrtcSessionId: 'webrtc-1' }]);
    expect(session.token).toBe('stt-key-1');

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(cloud.stt.extend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    expect(calls[1]).toEqual(['stt.extend', { id: 'stt-1', seconds: 600 }]);
    expect(keys).toEqual([session.token]);
    session.close();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(cloud.stt.extend).toHaveBeenCalledTimes(1);
  });

  it('retries a failed extension and reports it', async () => {
    vi.useFakeTimers();
    const { cloud } = fakeCloud();
    (cloud.stt.extend as any).mockRejectedValueOnce(new Error('insufficient_balance'));
    const errors: Error[] = [];
    const session = new CloudSpeechSession({
      kind: 'stt', cloud, onExtended: () => {}, onError: (e) => errors.push(e),
    });
    await session.open();
    await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
    expect(errors.map((e) => e.message)).toEqual(['insufficient_balance']);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(cloud.stt.extend).toHaveBeenCalledTimes(2);
    session.close();
  });

  it('extends TTS characters in the background before the hold runs low; only a text past the hold waits', async () => {
    const { cloud, calls } = fakeCloud();
    let release!: () => void;
    const extend = cloud.tts.extend as any;
    const original = extend.getMockImplementation();
    extend.mockImplementationOnce(async (...args: unknown[]) => {
      const result = original(...args);
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    });
    const keys: string[] = [];
    const session = new CloudSpeechSession({
      kind: 'tts', cloud, language: 'en', voice: 'af_heart', onExtended: (key) => keys.push(key), onError: () => {},
    });
    await session.open('webrtc-1');
    expect(calls[0]).toEqual(['tts.createSession', { maxCharacters: 2000, language: 'en', voice: 'af_heart', webrtcSessionId: 'webrtc-1' }]);

    await session.reserveCharacters(1400); // 600 left: above the 500 threshold
    expect(cloud.tts.extend).not.toHaveBeenCalled();
    await session.reserveCharacters(200); // 400 left: extends in the background, the text does not wait
    expect(calls[1]).toEqual(['tts.extend', { id: 'tts-1', characters: 2000 }]);
    await session.reserveCharacters(300); // still fits in the hold while the extension runs
    expect(cloud.tts.extend).toHaveBeenCalledTimes(1);
    expect(keys).toEqual([]);

    let reserved = false;
    const pastHold = session.reserveCharacters(200).then(() => { reserved = true; }); // 2100 > 2000: waits
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reserved).toBe(false);
    release();
    await pastHold;
    expect(keys).toEqual([session.token]);
    expect(cloud.tts.extend).toHaveBeenCalledTimes(1);

    await session.reserveCharacters(6000); // a long text: one extension covers it
    expect(calls[2]).toEqual(['tts.extend', { id: 'tts-1', characters: 4600 }]);
    session.close();
  });

  it('a failed background extension is reported; a text past the hold still gets an extension or fails', async () => {
    const { cloud } = fakeCloud();
    const extend = cloud.tts.extend as any;
    extend.mockRejectedValueOnce(new Error('insufficient_balance'));
    const errors: Error[] = [];
    const session = new CloudSpeechSession({
      kind: 'tts', cloud, onExtended: () => {}, onError: (e) => errors.push(e),
    });
    await session.open();

    await session.reserveCharacters(1600); // 400 left: the background extension fails
    await vi.waitFor(() => expect(errors.map((e) => e.message)).toEqual(['insufficient_balance']));
    await session.reserveCharacters(300); // fits: sent without waiting, no immediate retry
    expect(extend).toHaveBeenCalledTimes(1);

    await session.reserveCharacters(200); // 2100 > 2000: waits for an extension, which succeeds
    expect(extend).toHaveBeenCalledTimes(2);

    extend.mockRejectedValueOnce(new Error('insufficient_balance'));
    await expect(session.reserveCharacters(5000)).rejects.toThrow('insufficient_balance'); // past the hold, refused
    session.close();
  });

  it('rejects settings that cannot work', () => {
    const { cloud } = fakeCloud();
    const base = { kind: 'stt' as const, cloud, onExtended: () => {}, onError: () => {} };
    expect(() => new CloudSpeechSession({ ...base, stt: { minutes: 2, extendWhenMinutesLeft: 2 } })).toThrow('below');
    expect(() => new CloudSpeechSession({ ...base, tts: { characters: 0 } })).toThrow('positive');
  });
});

describe('DtelecomSTT in cloud mode', () => {
  it('opens one session per stream, linked to the room, and extends the open socket', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const server = await speechServer((ws, message) => {
      if (message.type === 'config' && message.session_key) ws.send(JSON.stringify({ type: 'ready', client_id: 'c', language: 'en' }));
    });
    const { cloud, calls } = fakeCloud(server.url);
    expect(() => new DtelecomSTT({})).toThrow('serverUrl');
    const stt = new DtelecomSTT({ cloud, language: 'en' });
    stt.setWebRTCSessionId('webrtc-1');

    const alice = stt.createStream();
    const bob = stt.createStream();
    cleanups.push(() => alice.close(), () => bob.close());
    await vi.waitFor(() => expect(server.connections).toHaveLength(2));
    await vi.waitFor(() => expect(server.connections.every((c) => c.length > 0)).toBe(true));

    expect(calls.filter(([name]) => name === 'stt.createSession').map(([, o]) => o))
      .toEqual([{ duration: 600, language: 'en', webrtcSessionId: 'webrtc-1' }, { duration: 600, language: 'en', webrtcSessionId: 'webrtc-1' }]);
    const keys = server.connections.map((c) => c[0].session_key).sort();
    expect(keys).toEqual(['stt-key-1', 'stt-key-2']);

    await vi.advanceTimersByTimeAsync(8 * 60_000 + 1);
    await vi.waitFor(() => expect(server.connections.flat().filter((m) => m.type === 'extend')).toHaveLength(2));
    for (const messages of server.connections) {
      const extension = messages.find((m) => m.type === 'extend');
      expect(extension.session_key).toMatch(new RegExp(`^${messages[0].session_key.replace('-key', '')}-ext-`));
    }
  });

  it('reports a session the cloud refuses', async () => {
    const { cloud } = fakeCloud();
    (cloud.stt.createSession as any).mockRejectedValueOnce(Object.assign(new Error('insufficient_balance'), { status: 402 }));
    const stream = new DtelecomSTT({ cloud }).createStream();
    cleanups.push(() => stream.close());
    const [error] = await once(stream as any, 'error');
    expect(error.message).toBe('insufficient_balance');
  });
});

describe('DtelecomTTS in cloud mode', () => {
  it('opens a session on first use, extends in the background and holds back only a text past the limit', async () => {
    const server = await speechServer((ws, message) => {
      if (message.text) {
        ws.send(JSON.stringify({ type: 'generating', text: message.text }));
        ws.send(Buffer.from([1, 0]));
        ws.send(JSON.stringify({ type: 'done' }));
      }
    });
    const { cloud, calls } = fakeCloud(server.url);
    const tts = new DtelecomTTS({
      cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } },
      cloudSession: { characters: 100, extendWhenCharactersLeft: 20 },
    });
    tts.setWebRTCSessionId('webrtc-1');
    cleanups.push(() => tts.close());

    const collect = async (text: string) => { const out: Buffer[] = []; for await (const c of tts.synthesize(text)) out.push(c); return out; };
    expect(await collect('Hello there')).toEqual([Buffer.from([1, 0])]);
    expect(calls[0]).toEqual(['tts.createSession', { maxCharacters: 100, language: 'en', voice: 'af_heart', webrtcSessionId: 'webrtc-1' }]);
    expect(server.connections[0][0].session_key).toBe('tts-key-1');

    // 11 + 80 leaves 9, under 20: the text is spoken at once while the hold is extended in the background.
    let release!: () => void;
    const extend = cloud.tts.extend as any;
    const original = extend.getMockImplementation();
    extend.mockImplementationOnce(async (...args: unknown[]) => {
      const result = original(...args);
      await new Promise<void>((resolve) => { release = resolve; });
      return result;
    });
    expect(await collect('x'.repeat(80))).toEqual([Buffer.from([1, 0])]);
    const messages = server.connections[0];
    expect(calls.filter(([name]) => name === 'tts.extend')).toHaveLength(1);
    expect(messages.some((m) => m.type === 'extend')).toBe(false);

    // A text past the hold waits for the extension; the new key reaches the socket before it.
    const pastHold = collect('y'.repeat(15));
    release();
    expect(await pastHold).toEqual([Buffer.from([1, 0])]);
    const extendAt = messages.findIndex((m) => m.type === 'extend');
    const textAt = messages.findIndex((m) => m.text === 'y'.repeat(15));
    expect(extendAt).toBeGreaterThan(0);
    expect(extendAt).toBeLessThan(textAt);
    expect(messages[extendAt].session_key).toMatch(/^tts-1-ext-/);
    expect(calls.filter(([name]) => name === 'tts.extend')).toHaveLength(1);
  });
});

describe('RoomConnection in cloud mode', () => {
  it('mints the agent token through the cloud and keeps its session id', async () => {
    const { cloud, calls } = fakeCloud();
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', identity: 'agent', name: 'Agent', cloud, ttl: '2h' });
    expect(calls[0]).toEqual(['createToken', { room: 'demo', identity: 'agent', name: 'Agent', ttl: '2h' }]);
    expect(connects[connects.length - 1]).toEqual({ url: 'wss://node.example', token: 'agent-token', fallbackUrls: ['wss://node.example', 'wss://b.example'] });
    expect(connection.webrtcSessionId).toBe('webrtc-1');
  });

  it('builds a CloudClient from an API key and secret', async () => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        requests.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session_id: 'webrtc-9', token: 'tok', ws_url: 'wss://n.example', expires_at: '2030-01-01T00:00:00Z' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const previous = process.env.DTELECOM_CLOUD_URL;
    process.env.DTELECOM_CLOUD_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    cleanups.push(() => { process.env.DTELECOM_CLOUD_URL = previous; });

    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', identity: 'bot', apiKey: 'k', apiSecret: 's' });
    expect(requests[0].path).toBe('/v1/webrtc/token');
    expect(requests[0].auth).toBe('Bearer k:s');
    expect(requests[0].body).toMatchObject({ room_name: 'demo', identity: 'bot', name: 'bot' });
    expect(connection.webrtcSessionId).toBe('webrtc-9');
  });

  it('passes through a pre-signed issuer list without requesting another token', async () => {
    const connection = new RoomConnection();
    const fallbackUrls = ['wss://node-a.example', 'wss://node-b.example'];
    await connection.connect({ room: 'demo', token: 'pre-signed', wsUrl: fallbackUrls[0], fallbackUrls });
    expect(connects.at(-1)).toEqual({ url: fallbackUrls[0], token: 'pre-signed', fallbackUrls });
    await connection.disconnect();
  });

  it('keeps the x402 token mode unchanged', async () => {
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', token: 'x402-token', wsUrl: 'wss://x402.example' });
    expect(connects[connects.length - 1]).toEqual({ url: 'wss://x402.example', token: 'x402-token' });
    expect(connection.webrtcSessionId).toBeNull();
  });
});

describe('VoiceAgent in cloud mode', () => {
  it('links the providers to its WebRTC session before the pipeline starts', async () => {
    const { cloud, calls } = fakeCloud();
    const stt = Object.assign(new MockSTT(), { setWebRTCSessionId: vi.fn() });
    const tts = Object.assign(new MockTTS(), { setWebRTCSessionId: vi.fn() });
    const agent = new VoiceAgent({ stt, tts, llm: new MockLLM(), instructions: 'test' });
    await agent.start({ room: 'demo', identity: 'assistant', cloud, ttl: '30m' });
    try {
      expect(calls[0]).toEqual(['createToken', { room: 'demo', identity: 'assistant', name: 'assistant', ttl: '30m' }]);
      expect(stt.setWebRTCSessionId).toHaveBeenCalledWith('webrtc-1');
      expect(tts.setWebRTCSessionId).toHaveBeenCalledWith('webrtc-1');
    } finally {
      await agent.stop();
    }
  });
});

describe('the agent token in cloud mode', () => {
  const minute = 60_000;
  const fake = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const cloudError = (status: number, code: string) => Object.assign(new Error(code), { status, code });

  it('extends by its ttl ten minutes before it expires, again and again', async () => {
    fake();
    const { cloud, calls } = fakeCloud();
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '2h' });
    cleanups.push(() => connection.disconnect());

    await vi.advanceTimersByTimeAsync(110 * minute - 1);
    expect(calls.filter(([name]) => name === 'extendToken')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.filter(([name]) => name === 'extendToken')).toEqual([['extendToken', { id: 'webrtc-1', seconds: 7200 }]]);
    expect(tokenUpdates.at(-1)).toEqual({ token: connection.token, fallbackUrls: ['wss://node.example', 'wss://c.example'] });
    expect(connection.token).toMatch(/^agent-token-/);

    await vi.advanceTimersByTimeAsync(120 * minute);
    expect(calls.filter(([name]) => name === 'extendToken')).toHaveLength(2);
  });

  it('extends a short token at half its life', async () => {
    fake();
    const { cloud, calls } = fakeCloud('https://speech.example', 10 * minute, 10 * minute);
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '10m' });
    cleanups.push(() => connection.disconnect());
    await vi.advanceTimersByTimeAsync(5 * minute);
    expect(calls.filter(([name]) => name === 'extendToken')).toEqual([['extendToken', { id: 'webrtc-1', seconds: 600 }]]);
  });

  it('retries a refused payment every 15 s and reports the failure once', async () => {
    fake();
    const { cloud } = fakeCloud();
    (cloud.extendToken as any)
      .mockRejectedValueOnce(cloudError(402, 'insufficient_balance'))
      .mockRejectedValueOnce(cloudError(402, 'insufficient_balance'));
    const errors: Error[] = [];
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '2h', onError: (e) => errors.push(e) });
    cleanups.push(() => connection.disconnect());

    await vi.advanceTimersByTimeAsync(110 * minute);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cloud.extendToken).toHaveBeenCalledTimes(3);
    expect(errors.map((e) => e.message)).toEqual(['insufficient_balance']);
    expect(connection.token).toMatch(/^agent-token-/);
  });

  it('stops after the expiry and its grace while the payment keeps failing', async () => {
    fake();
    const { cloud } = fakeCloud();
    (cloud.extendToken as any).mockRejectedValue(cloudError(402, 'insufficient_balance'));
    const errors: Error[] = [];
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '2h', onError: (e) => errors.push(e) });
    cleanups.push(() => connection.disconnect());

    await vi.advanceTimersByTimeAsync(125 * minute);
    const tries = (cloud.extendToken as any).mock.calls.length;
    // 10 minutes before expiry plus up to 50 s after it, every 15 s.
    expect(tries).toBeGreaterThan(40);
    expect(tries).toBeLessThan(46);
    expect(errors).toHaveLength(2); // the first failure, and the last one that gives up
  });

  it('reports a session past its expiry once and does not retry', async () => {
    fake();
    const { cloud } = fakeCloud();
    (cloud.extendToken as any).mockRejectedValue(cloudError(409, 'session_not_extendable'));
    const errors: Error[] = [];
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '2h', onError: (e) => errors.push(e) });
    cleanups.push(() => connection.disconnect());
    await vi.advanceTimersByTimeAsync(130 * minute);
    expect(cloud.extendToken).toHaveBeenCalledTimes(1);
    expect(errors.map((e) => e.message)).toEqual(['session_not_extendable']);
  });

  it('stops extending once disconnected, and never in x402 mode', async () => {
    fake();
    const { cloud } = fakeCloud();
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', cloud, ttl: '2h' });
    await connection.disconnect();
    const x402 = new RoomConnection();
    await x402.connect({ room: 'demo', token: 'x402-token', wsUrl: 'wss://x402.example' });
    cleanups.push(() => x402.disconnect());
    await vi.advanceTimersByTimeAsync(24 * 60 * minute);
    expect(cloud.extendToken).not.toHaveBeenCalled();
  });

  it('reaches the agent as an error event', async () => {
    fake();
    const { cloud } = fakeCloud();
    (cloud.extendToken as any).mockRejectedValue(cloudError(409, 'session_not_extendable'));
    const agent = new VoiceAgent({ stt: new MockSTT(), tts: new MockTTS(), llm: new MockLLM(), instructions: 'test' });
    const errors: Error[] = [];
    agent.on('error', (e) => errors.push(e));
    await agent.start({ room: 'demo', cloud, ttl: '2h' });
    cleanups.push(() => agent.stop());
    await vi.advanceTimersByTimeAsync(111 * minute);
    expect(errors.map((e) => e.message)).toEqual(['session_not_extendable']);
  });
});

describe('speech reconnects in cloud mode open a new session', () => {
  it('STT: a lost connection opens a new session in the current language', async () => {
    const server = await speechServer((ws, message) => {
      if (message.type === 'config' && message.session_key) ws.send(JSON.stringify({ type: 'ready', client_id: 'c', language: 'en' }));
    });
    const { cloud, calls } = fakeCloud(server.url);
    const stt = new DtelecomSTT({ cloud, language: 'en' });
    stt.setWebRTCSessionId('webrtc-1');
    const stream = stt.createStream();
    cleanups.push(() => stream.close());
    await vi.waitFor(() => expect(server.connections[0]?.[0]?.session_key).toBe('stt-key-1'));
    stream.setLanguage!('ru');

    server.drop();
    await vi.waitFor(() => expect(server.connections[1]?.[0]?.session_key).toBe('stt-key-2'), { timeout: 3000 });
    expect(server.connections[1][0].language).toBe('ru');
    expect(calls.filter(([name]) => name === 'stt.createSession').map(([, o]) => o.language)).toEqual(['en', 'ru']);
  });

  it('TTS: the next text after a lost connection opens a new session', async () => {
    const server = await speechServer((ws, message) => {
      if (message.text) {
        ws.send(JSON.stringify({ type: 'generating', text: message.text }));
        ws.send(Buffer.from([1, 0]));
        ws.send(JSON.stringify({ type: 'done' }));
      }
    });
    const { cloud, calls } = fakeCloud(server.url);
    const tts = new DtelecomTTS({ cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } } });
    cleanups.push(() => tts.close());
    const collect = async (text: string) => { const out: Buffer[] = []; for await (const c of tts.synthesize(text)) out.push(c); return out; };

    await collect('Hello');
    expect(server.connections[0][0].session_key).toBe('tts-key-1');
    server.drop();
    await vi.waitFor(() => expect((tts as any).ws).toBeNull());
    await collect('Again');
    expect(server.connections[1][0].session_key).toBe('tts-key-2');
    expect(calls.filter(([name]) => name === 'tts.createSession')).toHaveLength(2);
  });

  it('uses the cloud stream_url when given, and builds it otherwise', async () => {
    const { cloud } = fakeCloud('https://speech.example');
    (cloud.stt.createSession as any).mockResolvedValueOnce({
      sessionId: 's', token: 'k', serverUrl: 'https://speech.example', streamUrl: 'wss://stream.example/v1/stream',
      expiresAt: new Date(Date.now() + 600_000),
    });
    const given = new CloudSpeechSession({ kind: 'stt', cloud, onExtended: () => {}, onError: () => {} });
    await given.open();
    given.close();
    expect(given.streamUrl).toBe('wss://stream.example/v1/stream');
    const built = new CloudSpeechSession({ kind: 'stt', cloud, onExtended: () => {}, onError: () => {} });
    await built.open();
    built.close();
    expect(built.streamUrl).toBe('wss://speech.example/v1/stream');
  });
});
