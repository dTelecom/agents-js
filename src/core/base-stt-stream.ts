import { EventEmitter } from 'events';
import type { STTStream, TranscriptionResult } from './types';

/**
 * Abstract base class for STT streams.
 * Provides typed EventEmitter interface for transcription events.
 * Provider implementations should extend this class.
 */
export abstract class BaseSTTStream extends EventEmitter implements STTStream {
  abstract sendAudio(pcm16: Buffer): void;
  abstract close(): Promise<void>;

  override on(event: 'transcription', cb: (result: TranscriptionResult) => void): this;
  override on(event: 'error', cb: (error: Error) => void): this;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override on(event: string, cb: (...args: any[]) => void): this {
    return super.on(event, cb);
  }

  override emit(event: 'transcription', result: TranscriptionResult): boolean;
  override emit(event: 'error', error: Error): boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}
