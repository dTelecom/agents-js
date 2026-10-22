import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import type { LLMPlugin, TTSPlugin } from '../src/core/types';
import { MockSTT, MockAudioOutput } from './helpers/mock-providers';

vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
}));

describe.each([true, false])('Multilingual speech (sequential=%s)', (sequential) => {
  let pipeline: Pipeline;

  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
  afterEach(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    await pipeline?.stop();
    vi.useRealTimers();
  });

  async function speak(sentences: string[]) {
    const stt = new MockSTT();
    const output = new MockAudioOutput();
    const synthesized: string[] = [];
    const spoken: string[] = [];
    const llm: LLMPlugin = {
      async *chat() {
        // Queue both sentences together, exercising the prefetch filter too.
        yield { type: 'token', token: sentences.join(' ') };
      },
    };
    const tts: TTSPlugin = {
      sequential,
      async *synthesize(text) {
        synthesized.push(text);
        yield Buffer.from([1, 0]);
      },
    };
    pipeline = new Pipeline({ stt, llm, tts, audioOutput: output as any, instructions: 'Be helpful.' });
    pipeline.on('sentence', (text) => spoken.push(text));
    pipeline.addParticipant('user');
    stt.streams[0].simulateTranscription('Question', true);
    await vi.advanceTimersByTimeAsync(1000);
    return { synthesized, spoken, output };
  }

  it.each([
    ['Russian', 'Если вы имеете в виду букву «е», это буква русского алфавита.'],
    ['Russian definition', 'ИИ — это искусственный интеллект: технологии, которые помогают людям.'],
    ['Arabic', 'الذكاء الاصطناعي يساعد الناس في أعمالهم.'],
    ['Greek', 'Η τεχνητή νοημοσύνη βοηθά τους ανθρώπους.'],
    ['Hindi', 'कृत्रिम बुद्धिमत्ता लोगों की मदद करती है.'],
    ['Japanese', '人工知能は人々のさまざまな仕事を支援する技術です.'],
    ['Chinese', '人工智能是一种可以帮助人们完成各种日常工作的技术.'],
    ['English', 'Artificial intelligence helps people with their work.'],
    ['Unicode numbers', '１２３４５６７８９０１２３４５６７８９０１２３４５.'],
  ])('speaks both %s sentences without dropping either', async (_language, sentence) => {
    const { synthesized, spoken, output } = await speak([sentence, sentence]);
    expect(synthesized).toEqual([sentence, sentence]);
    expect(spoken).toEqual([sentence, sentence]);
    expect(output.writtenBuffers).toHaveLength(2);
  });

  it('keeps a Russian definition before a sentence containing a Latin brand name', async () => {
    const sentences = [
      'ИИ — это искусственный интеллект: технологии, которые помогают людям.',
      'dTelecom предоставляет инструменты для создания голосовых ИИ-агентов.',
    ];
    const { synthesized, spoken } = await speak(sentences);
    expect(synthesized.sort()).toEqual([...sentences].sort());
    expect(spoken).toEqual(sentences);
  });

  it('preserves a Russian sentence queued after an English sentence for prefetch', async () => {
    const sentences = ['Here is the explanation you requested.', 'ИИ — это искусственный интеллект.'];
    const { synthesized, spoken } = await speak(sentences);
    expect(synthesized.sort()).toEqual([...sentences].sort());
    expect(spoken).toEqual(sentences);
  });

  it('skips punctuation, symbols and whitespace without speech', async () => {
    const { synthesized, spoken, output } = await speak(['   — … 🎉 ___   ']);
    expect(synthesized).toEqual([]);
    expect(spoken).toEqual([]);
    expect(output.writtenBuffers).toEqual([]);
  });
});
