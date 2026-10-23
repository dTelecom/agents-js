import { once } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { DtelecomTTS } from '../src/providers/dtelecom-tts';

vi.mock('../src/utils/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

async function fixture(option?: boolean, supported: unknown = true, confirmation: unknown = 'active') {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const messages: Record<string, any>[] = [];
  server.on('connection', ws => ws.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    if (message.type === 'capabilities') {
      ws.send(JSON.stringify({ type: 'capabilities', watermark: supported, ssml_profiles: ['dtelecom-ssml-v1'] }));
    }
    if (message.text) {
      if (confirmation !== 'omit-generating') ws.send(JSON.stringify({ type: 'generating', text: message.text, watermark: confirmation }));
      ws.send(Buffer.from([1, 0, 2, 0]));
      ws.send(JSON.stringify({ type: 'done' }));
    }
    if (message.type === 'clear') ws.send(JSON.stringify({ type: 'cleared' }));
  }));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const tts = new DtelecomTTS({ serverUrl: `http://127.0.0.1:${address.port}`, sessionKey: 'test',
    voices: { en: { voice: 'M5', langCode: 'en' } }, watermark: option });
  return { tts, messages, async close() {
    tts.close(); for (const ws of server.clients) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
async function collect(stream: AsyncGenerator<Buffer>) {
  const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks;
}

describe('explicit TTS watermark opt-in', () => {
  it.each([undefined, false])('preserves the plain legacy wire path for %s', async value => {
    const f = await fixture(value);
    try {
      expect(await collect(f.tts.synthesize('Hello'))).toEqual([Buffer.from([1,0,2,0])]);
      expect(f.messages.some(m => m.type === 'capabilities')).toBe(false);
      expect(f.messages.find(m => m.text)).not.toHaveProperty('watermark');
      expect(f.messages.find(m => m.session_key)?.config).not.toHaveProperty('watermark');
    } finally { await f.close(); }
  });

  it.each(['text','ssml'])('confirms support and marks every %s request, including reconnect', async format => {
    const f = await fixture(true);
    const run = () => collect(format === 'text' ? f.tts.synthesize('Hello') : f.tts.synthesizeSSML('<speak>Hello</speak>'));
    try {
      expect(await run()).toEqual([Buffer.from([1,0,2,0])]);
      f.tts.close();
      expect(await run()).toEqual([Buffer.from([1,0,2,0])]);
      const requests = f.messages.filter(m => m.text);
      expect(requests).toHaveLength(2);
      expect(requests.every(m => m.watermark === true)).toBe(true);
      expect(f.messages.filter(m => m.type === 'capabilities')).toHaveLength(2);
      if (format === 'ssml') expect(requests.every(m => m.input_format === 'ssml')).toBe(true);
    } finally { await f.close(); }
  });

  it.each([false, null, 'true'])('rejects unsupported/old server capability %s before sending speech', async capability => {
    const f = await fixture(true, capability);
    try {
      await expect(collect(f.tts.synthesize('Hello'))).rejects.toThrow('does not enable TTS watermarking');
      expect(f.messages.filter(m => m.text)).toEqual([]);
    } finally { await f.close(); }
  });

  it.each([null, 'disabled', 'omit-generating'])('never yields unconfirmed audio (%s)', async confirmation => {
    const f = await fixture(true, true, confirmation);
    const received: Buffer[] = [];
    try {
      await expect((async () => { for await (const b of f.tts.synthesize('Hello')) received.push(b); })()).rejects.toThrow(/confirm/);
      expect(received).toEqual([]);
    } finally { await f.close(); }
  });

  it('does not send speech when aborted before activation', async () => {
    const f = await fixture(true); const controller = new AbortController(); controller.abort();
    try {
      expect(await collect(f.tts.synthesize('Hello', controller.signal))).toEqual([]);
      expect(f.messages).toEqual([]);
    } finally { await f.close(); }
  });

  it('negotiates during warmup once per socket without a round trip for each phrase', async () => {
    const f = await fixture(true);
    try {
      await f.tts.warmup();
      await collect(f.tts.synthesize('One'));
      await collect(f.tts.synthesizeSSML('<speak>Two</speak>'));
      expect(f.messages.filter(m => m.type === 'capabilities')).toHaveLength(1);
      expect(f.messages.filter(m => m.text)).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('clears a cancelled marked request and requires fresh activation for the next', async () => {
    const f = await fixture(true); const controller = new AbortController();
    try {
      for await (const chunk of f.tts.synthesize('First', controller.signal)) {
        expect(chunk.length).toBe(4);
        controller.abort();
      }
      expect(f.messages.some(m => m.type === 'clear')).toBe(true);
      expect(await collect(f.tts.synthesize('Next'))).toEqual([Buffer.from([1,0,2,0])]);
      expect(f.messages.filter(m => m.text).map(m => m.watermark)).toEqual([true,true]);
    } finally { await f.close(); }
  });
});
