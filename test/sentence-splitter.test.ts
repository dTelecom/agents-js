import { describe, it, expect } from 'vitest';
import { SentenceSplitter } from '../src/core/sentence-splitter';

describe('SentenceSplitter', () => {
  it('splits at sentence boundary', () => {
    const s = new SentenceSplitter();
    // "Hello world." is only 12 chars — below MIN_CHUNK (20)
    // So push a longer sentence that exceeds MIN_CHUNK
    const chunks = s.push('This is a test sentence. ');
    expect(chunks).toEqual(['This is a test sentence.']);
  });

  it('respects MIN_CHUNK — short sentence waits for more', () => {
    const s = new SentenceSplitter();
    const chunks = s.push('Hi. ');
    // "Hi." is 3 chars — below MIN_CHUNK, so no split
    expect(chunks).toEqual([]);
  });

  it('a short first sentence joins the next one instead of holding the answer back', () => {
    const s = new SentenceSplitter();
    expect(s.push('Hi. ')).toEqual([]);
    expect(s.push('This is more text that goes on. ')).toEqual(['Hi. This is more text that goes on.']);
    expect(s.flush()).toBeNull();
  });

  it('splits at clause boundary when buffer exceeds MAX_CHUNK', () => {
    const s = new SentenceSplitter();
    // Create a string > 250 chars with a comma after position 20
    const longText = 'A'.repeat(30) + ', ' + 'B'.repeat(230);
    const chunks = s.push(longText);
    expect(chunks.length).toBeGreaterThan(0);
    // Should split at the comma
    expect(chunks[0]).toMatch(/,$/);
  });

  it('does NOT split at clause boundary when buffer is under MAX_CHUNK', () => {
    const s = new SentenceSplitter();
    // 160 chars with comma — under MAX_CHUNK (250), should NOT split
    const text = 'dTelecom is a decentralized real-time communication platform designed to provide voice, video, chat, and livestreaming capabilities.';
    const chunks = s.push(text + ' ');
    // Should split at the sentence-ending period, not at commas
    expect(chunks).toEqual([text]);
  });

  it('forces word boundary split when no punctuation and buffer exceeds MAX_CHUNK', () => {
    const s = new SentenceSplitter();
    // 260 chars of words with spaces but no punctuation
    const words = [];
    let len = 0;
    while (len < 260) {
      const word = 'word';
      words.push(word);
      len += word.length + 1;
    }
    const longText = words.join(' ');
    const chunks = s.push(longText);
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk should be <= 250 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(250);
    }
  });

  it('flush returns remaining text', () => {
    const s = new SentenceSplitter();
    s.push('partial text without sentence end');
    const flushed = s.flush();
    expect(flushed).toBe('partial text without sentence end');
  });

  it('flush returns null when empty', () => {
    const s = new SentenceSplitter();
    expect(s.flush()).toBeNull();
  });

  it('flush returns null after already flushed', () => {
    const s = new SentenceSplitter();
    s.push('some text');
    s.flush();
    expect(s.flush()).toBeNull();
  });

  it('reset clears buffer', () => {
    const s = new SentenceSplitter();
    s.push('some text in buffer');
    s.reset();
    expect(s.flush()).toBeNull();
  });

  it('handles multi-sentence input', () => {
    const s = new SentenceSplitter();
    const chunks = s.push('First sentence is long enough. Second sentence also long enough. ');
    // Both sentences are > MIN_CHUNK chars
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe('First sentence is long enough.');
    expect(chunks[1]).toBe('Second sentence also long enough.');
  });

  it('accumulates tokens across multiple push calls', () => {
    const s = new SentenceSplitter();
    expect(s.push('This is ')).toEqual([]);
    expect(s.push('a test ')).toEqual([]);
    const chunks = s.push('sentence. ');
    expect(chunks).toEqual(['This is a test sentence.']);
  });

  it('keeps decimals, versions and domains whole, whatever the token boundaries', () => {
    const text = 'Streaming speech-to-text costs $0.004 per minute. Install version 4.2.1 from docs.dtelecom.org today. ';
    for (const size of [1, 2, 3, 5, 7, 11]) {
      const s = new SentenceSplitter();
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) chunks.push(...s.push(text.slice(i, i + size)));
      const rest = s.flush();
      if (rest) chunks.push(rest);
      expect(chunks).toEqual(['Streaming speech-to-text costs $0.004 per minute.', 'Install version 4.2.1 from docs.dtelecom.org today.']);
    }
  });

  it('waits for the next token when a period ends the buffer', () => {
    const s = new SentenceSplitter();
    expect(s.push('File transcription costs $0.')).toEqual([]);
    expect(s.push('002 per minute. ')).toEqual(['File transcription costs $0.002 per minute.']);
  });

  it('does not end a sentence after common abbreviations', () => {
    const s = new SentenceSplitter();
    expect(s.push('Many languages are supported, e.g. English and Russian. Dr. Smith agrees with this. ')).toEqual([
      'Many languages are supported, e.g. English and Russian.',
      'Dr. Smith agrees with this.',
    ]);
    expect(new SentenceSplitter().push('The short answer is no. It needs a paid plan to work. ')).toEqual([
      'The short answer is no.',
      'It needs a paid plan to work.',
    ]);
  });

  it('splits at closing quotes and at CJK, Devanagari and Arabic sentence ends', () => {
    expect(new SentenceSplitter().push('He said "this is the end." And then he left the room. ')).toEqual([
      'He said "this is the end."',
      'And then he left the room.',
    ]);
    const zh = new SentenceSplitter();
    expect(zh.push('这是一个很长的句子，用来测试中文的分句是否正常工作。第二句话较短。')).toEqual([
      '这是一个很长的句子，用来测试中文的分句是否正常工作。',
    ]);
    // A short last sentence waits for the end of the answer, as in every language.
    expect(zh.flush()).toBe('第二句话较短。');
    expect(new SentenceSplitter().push('यह एक लंबा वाक्य है जो परीक्षण के लिए है। दूसरा वाक्य भी काफी लंबा है।')).toEqual([
      'यह एक लंबा वाक्य है जो परीक्षण के लिए है।',
      'दूसरा वाक्य भी काफी लंबा है।',
    ]);
    expect(new SentenceSplitter().push('هل تريد أن تعرف المزيد عن الخدمة؟ يمكنك زيارة الموقع الآن. ')).toEqual([
      'هل تريد أن تعرف المزيد عن الخدمة؟',
      'يمكنك زيارة الموقع الآن.',
    ]);
  });
});
