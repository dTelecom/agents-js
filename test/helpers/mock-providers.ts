/**
 * Mock implementations of STT, LLM, TTS, and AudioOutput for testing.
 * No credentials or network calls required.
 */

import { EventEmitter } from 'events';
import type {
  STTPlugin,
  STTStream,
  STTStreamOptions,
  TranscriptionResult,
  LLMPlugin,
  LLMChunk,
  Message,
  TTSPlugin,
} from '../../src/core/types';

// ─── MockSTTStream ──────────────────────────────────────────────────────────

export class MockSTTStream extends EventEmitter implements STTStream {
  readonly audioBuffers: Buffer[] = [];
  private _closed = false;

  get closed(): boolean {
    return this._closed;
  }

  sendAudio(pcm16: Buffer): void {
    this.audioBuffers.push(pcm16);
  }

  simulateTranscription(text: string, isFinal: boolean): void {
    const result: TranscriptionResult = { text, isFinal };
    this.emit('transcription', result);
  }

  simulateError(error: Error): void {
    this.emit('error', error);
  }

  async close(): Promise<void> {
    this._closed = true;
  }
}

// ─── MockSTT ────────────────────────────────────────────────────────────────

export class MockSTT implements STTPlugin {
  readonly streams: MockSTTStream[] = [];

  createStream(_options?: STTStreamOptions): MockSTTStream {
    const stream = new MockSTTStream();
    this.streams.push(stream);
    return stream;
  }
}

// ─── MockLLM ────────────────────────────────────────────────────────────────

export class MockLLM implements LLMPlugin {
  readonly calls: Message[][] = [];
  response: string;
  tokenDelayMs: number;

  constructor(response = 'This is a test response.', tokenDelayMs = 0) {
    this.response = response;
    this.tokenDelayMs = tokenDelayMs;
  }

  async *chat(messages: Message[], signal?: AbortSignal): AsyncGenerator<LLMChunk> {
    this.calls.push(messages);
    const words = this.response.split(' ');

    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      if (this.tokenDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.tokenDelayMs));
      }
      if (signal?.aborted) return;

      const token = i === 0 ? words[i] : ` ${words[i]}`;
      yield { type: 'token', token };
    }

    yield { type: 'done', usage: { promptTokens: 10, completionTokens: words.length } };
  }
}

// ─── MockTTS ────────────────────────────────────────────────────────────────

export class MockTTS implements TTSPlugin {
  readonly synthesizeCalls: string[] = [];
  chunkDelayMs: number;
  chunksPerCall: number;

  constructor(chunkDelayMs = 0, chunksPerCall = 2) {
    this.chunkDelayMs = chunkDelayMs;
    this.chunksPerCall = chunksPerCall;
  }

  async *synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    this.synthesizeCalls.push(text);

    for (let i = 0; i < this.chunksPerCall; i++) {
      if (signal?.aborted) return;
      if (this.chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.chunkDelayMs));
      }
      if (signal?.aborted) return;

      // Small PCM16 buffer (320 samples = 20ms at 16kHz)
      yield Buffer.alloc(640);
    }
  }
}

// ─── MockAudioOutput ────────────────────────────────────────────────────────

export class MockAudioOutput {
  private _playing = false;
  private _responding = false;
  readonly writtenBuffers: Buffer[] = [];
  readonly streamCalls: number[] = [];
  private _flushed = false;
  private _stopped = false;

  get playing(): boolean {
    return this._playing;
  }

  set playing(value: boolean) {
    this._playing = value;
  }

  get flushed(): boolean {
    return this._flushed;
  }

  beginResponse(): void {
    this._responding = true;
  }

  endResponse(): void {
    this._responding = false;
  }

  flush(): void {
    this._flushed = true;
    this._playing = false;
  }

  async writeStream(stream: AsyncIterable<Buffer>, signal?: AbortSignal): Promise<void> {
    this._playing = true;
    let chunkCount = 0;
    try {
      for await (const chunk of stream) {
        if (signal?.aborted) break;
        this.writtenBuffers.push(chunk);
        chunkCount++;
      }
    } finally {
      this._playing = false;
      this.streamCalls.push(chunkCount);
    }
  }

  async writeBuffer(pcm16: Buffer): Promise<void> {
    this._playing = true;
    this.writtenBuffers.push(pcm16);
    this._playing = false;
  }

  async writeSilence(_durationMs: number): Promise<void> {
    // no-op in tests
  }

  startSilence(): void {
    // no-op in tests
  }

  stop(): void {
    this._stopped = true;
    this._playing = false;
  }
}
