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

const connects: Array<{ url: string; token: string }> = [];
vi.mock('@dtelecom/server-sdk-node', () => ({
  Room: class {
    remoteParticipants = new Map();
    localParticipant = { async publishTrack() {}, async unpublishTrack() {} };
    on() {}
    async connect(url: string, token: string) { connects.push({ url, token }); }
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

/** A cloud that records calls; sessions point at `serverUrl` and expire after `ttlMs`. */
function fakeCloud(serverUrl = 'https://speech.example', ttlMs = 10 * 60_000) {
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
      return { token: 'agent-token', wsUrl: 'wss://node.example', sessionId: 'webrtc-1', expiresAt: new Date() };
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
  return { url: `http://127.0.0.1:${port}`, connections };
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

  it('reserves TTS characters, extending before a text passes the limit', async () => {
    const { cloud, calls } = fakeCloud();
    const session = new CloudSpeechSession({
      kind: 'tts', cloud, language: 'en', voice: 'af_heart', onExtended: () => {}, onError: () => {},
    });
    await session.open('webrtc-1');
    expect(calls[0]).toEqual(['tts.createSession', { maxCharacters: 2000, language: 'en', voice: 'af_heart', webrtcSessionId: 'webrtc-1' }]);

    await session.reserveCharacters(1400); // 600 left: above the 500 threshold
    expect(cloud.tts.extend).not.toHaveBeenCalled();
    await session.reserveCharacters(200); // would leave 400
    expect(calls[1]).toEqual(['tts.extend', { id: 'tts-1', characters: 2000 }]);
    await session.reserveCharacters(6000); // a long text: one extension covers it
    expect(calls[2]).toEqual(['tts.extend', { id: 'tts-1', characters: 4100 }]);
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
  it('opens a session on first use and extends before sending a text past the limit', async () => {
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

    await collect('x'.repeat(80)); // 11 + 80 would leave 9, under 20
    const messages = server.connections[0];
    const extendAt = messages.findIndex((m) => m.type === 'extend');
    const textAt = messages.findIndex((m) => m.text === 'x'.repeat(80));
    expect(extendAt).toBeGreaterThan(0);
    expect(extendAt).toBeLessThan(textAt);
    expect(calls.filter(([name]) => name === 'tts.extend')).toHaveLength(1);
  });
});

describe('RoomConnection in cloud mode', () => {
  it('mints the agent token through the cloud and keeps its session id', async () => {
    const { cloud, calls } = fakeCloud();
    const connection = new RoomConnection();
    await connection.connect({ room: 'demo', identity: 'agent', name: 'Agent', cloud, ttl: '2h' });
    expect(calls[0]).toEqual(['createToken', { room: 'demo', identity: 'agent', name: 'Agent', ttl: '2h' }]);
    expect(connects[connects.length - 1]).toEqual({ url: 'wss://node.example', token: 'agent-token' });
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
