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

  it('short sentence stays buffered until combined chunk is large enough', () => {
    const s = new SentenceSplitter();
    let chunks = s.push('Hi. ');
    expect(chunks).toEqual([]);
    // Adding more text — the regex still matches "Hi. " first (< MIN_CHUNK),
    // and total buffer < MAX_CHUNK, so nothing splits yet
    chunks = s.push('This is more text that goes on. ');
    expect(chunks).toEqual([]);
    // But flush returns the accumulated buffer
    expect(s.flush()).toBe('Hi. This is more text that goes on.');
  });

  it('splits at clause boundary when buffer exceeds MAX_CHUNK', () => {
    const s = new SentenceSplitter();
    // Create a string > 150 chars with a comma after position 20
    const longText = 'A'.repeat(30) + ', ' + 'B'.repeat(130);
    const chunks = s.push(longText);
    expect(chunks.length).toBeGreaterThan(0);
    // Should split at the comma
    expect(chunks[0]).toMatch(/,$/);
  });

  it('forces word boundary split when no punctuation and buffer exceeds MAX_CHUNK', () => {
    const s = new SentenceSplitter();
    // 160 chars of words with spaces but no punctuation
    const words = [];
    let len = 0;
    while (len < 160) {
      const word = 'word';
      words.push(word);
      len += word.length + 1;
    }
    const longText = words.join(' ');
    const chunks = s.push(longText);
    expect(chunks.length).toBeGreaterThan(0);
    // Each chunk should be <= 150 chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(150);
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
});
