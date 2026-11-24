/**
 * SentenceSplitter — buffers streaming LLM tokens into speakable chunks
 * for TTS synthesis.
 *
 * Split strategy:
 * 1. Sentence end — split at the first one that completes a chunk of at least MIN_CHUNK chars.
 *    A sentence ends at `.`, `!`, `?` or `؟` (plus closing quotes or brackets) followed by whitespace,
 *    so decimals, versions and domains ($0.004, 4.2.1, docs.example.com) stay whole, or at a
 *    CJK or Devanagari full stop (。！？।), which needs no space. A `.` after a common abbreviation (e.g., Dr.)
 *    is not an end. A `.` at the very end of the buffer waits for the next token.
 * 2. Clause boundary (,;:—) — split if buffer >= MAX_CHUNK chars
 * 3. Word boundary — forced split if buffer >= MAX_CHUNK chars
 */

const MIN_CHUNK = 20;
const MAX_CHUNK = 250;

const SENTENCE_END = /[.!?\u061f]+["'\u201d\u2019\u00bb)\]]*\s+|[\u3002\uff01\uff1f\u0964]+["'\u201d\u2019\u300d\u300f)\uff09]*\s*/g;
/** Words whose trailing `.` does not end a sentence (compared in lower case, without the dot). */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'approx', 'inc', 'ltd', 'u.s']);

/** End of the first sentence that makes a chunk of at least MIN_CHUNK chars, or -1. */
function sentenceEnd(buffer: string): number {
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(buffer); match; match = SENTENCE_END.exec(buffer)) {
    const end = match.index + match[0].length;
    if (match[0].startsWith('.')) {
      const word = buffer.slice(0, match.index).match(/([\p{L}.]+)$/u)?.[1]?.toLowerCase();
      if (word && ABBREVIATIONS.has(word)) continue;
    }
    if (buffer.slice(0, end).trim().length >= MIN_CHUNK) return end;
  }
  return -1;
}

export class SentenceSplitter {
  private buffer = '';

  /** Add a token and get back any speakable chunks */
  push(token: string): string[] {
    this.buffer += token;
    return this.extractChunks();
  }

  /** Flush any remaining text as a final chunk */
  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = '';
    return text.length > 0 ? text : null;
  }

  /** Reset the splitter */
  reset(): void {
    this.buffer = '';
  }

  private extractChunks(): string[] {
    const chunks: string[] = [];

    while (true) {
      // 1. Sentence end — split on complete sentences
      const end = sentenceEnd(this.buffer);
      if (end > 0) {
        chunks.push(this.buffer.slice(0, end).trim());
        this.buffer = this.buffer.slice(end);
        continue;
      }

      // 2. Clause boundary (,;:—) if buffer is getting long
      if (this.buffer.length >= MAX_CHUNK) {
        const clauseMatch = this.buffer.match(/[,;:\u2014]\s*/);
        if (clauseMatch && clauseMatch.index !== undefined && clauseMatch.index >= MIN_CHUNK) {
          const end = clauseMatch.index + clauseMatch[0].length;
          const chunk = this.buffer.slice(0, end).trim();
          chunks.push(chunk);
          this.buffer = this.buffer.slice(end);
          continue;
        }

        // 3. Word boundary — forced split
        const spaceIdx = this.buffer.lastIndexOf(' ', MAX_CHUNK);
        if (spaceIdx >= MIN_CHUNK) {
          const chunk = this.buffer.slice(0, spaceIdx).trim();
          chunks.push(chunk);
          this.buffer = this.buffer.slice(spaceIdx);
          continue;
        }
      }

      break;
    }

    return chunks;
  }
}
