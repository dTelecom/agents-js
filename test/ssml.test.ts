import { once } from 'events';
import { describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { DtelecomTTS } from '../src/providers/dtelecom-tts';
import { Pipeline } from '../src/core/pipeline';
import { MockSTT, MockLLM, MockAudioOutput, MockTTS } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({ createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));
const ssml = '<speak>Hello.<break time="400ms"/><lang xml:lang="es">Hola.</lang></speak>';

describe('complete-document SSML', () => {
  it.each([true, false])('negotiates support before forwarding intact markup (%s)', async (enabled) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const messages: Record<string, unknown>[] = [];
    server.on('connection', ws => ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'capabilities') ws.send(JSON.stringify({ type: 'capabilities', ssml_profiles: enabled ? ['dtelecom-ssml-v1'] : [] }));
      if (message.text) {
        messages.push(message);
        ws.send(Buffer.from([1, 0]));
        ws.send(JSON.stringify({ type: 'done' }));
      }
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test port');
    const tts = new DtelecomTTS({ serverUrl: `http://127.0.0.1:${address.port}`, sessionKey: 'test', voices: { en: { voice: 'M5', langCode: 'en' } } });
    try {
      const collect = async () => { const chunks: Buffer[] = []; for await (const chunk of tts.synthesizeSSML(ssml)) chunks.push(chunk); return chunks; };
      if (enabled) {
        expect(await collect()).toEqual([Buffer.from([1, 0])]);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ text: ssml, input_format: 'ssml' });
      } else {
        await expect(collect()).rejects.toThrow('does not enable');
        expect(messages).toEqual([]);
      }
    } finally {
      tts.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('pipeline uses one SSML stream and plain context/events', async () => {
    const tts = new MockTTS();
    const synthesizeSSML = vi.fn(async function* (_source: string, _signal?: AbortSignal) { yield Buffer.from([1, 0]); });
    const llm = new MockLLM('unused');
    const output = new MockAudioOutput();
    const pipeline = new Pipeline({ stt: new MockSTT(), llm, tts: Object.assign(tts, { synthesizeSSML }), audioOutput: output as any, instructions: 'test' });
    const responses: string[] = [];
    pipeline.on('response', text => responses.push(text));
    try {
      await pipeline.say('Hello. Hola.', { ssml });
      expect(synthesizeSSML).toHaveBeenCalledTimes(1);
      expect(synthesizeSSML.mock.calls[0][0]).toBe(ssml);
      expect(responses).toEqual(['Hello. Hola.']);
      expect(llm.calls).toHaveLength(0);
    } finally { await pipeline.stop(); }
  });
});
