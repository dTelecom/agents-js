/**
 * SentenceSplitter — buffers streaming LLM tokens into speakable chunks
 * for TTS synthesis.
 *
 * Split strategy:
 * 1. Sentence boundary (.!?) — always split
 * 2. Clause boundary (,;:—) — split if buffer >= MIN_CHUNK chars
 * 3. Word boundary — forced split if buffer >= MAX_CHUNK chars
 */

const MIN_CHUNK = 20;
const MAX_CHUNK = 150;

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
      // 1. Sentence boundary (.!?) — split on complete sentences
      const sentenceMatch = this.buffer.match(/[^.!?]*[.!?]\s*/);
      if (sentenceMatch && sentenceMatch.index !== undefined) {
        const end = sentenceMatch.index + sentenceMatch[0].length;
        const chunk = this.buffer.slice(0, end).trim();
        if (chunk.length >= MIN_CHUNK) {
          chunks.push(chunk);
          this.buffer = this.buffer.slice(end);
          continue;
        }
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
