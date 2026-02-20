import { RemoteAudioTrack, AudioStream, AudioFrame } from '@dtelecom/server-sdk-node';
import { createLogger } from '../utils/logger';

const log = createLogger('AudioInput');

export class AudioInput {
  readonly participantIdentity: string;
  private stream: AudioStream;
  private _closed = false;
  private frameCount = 0;

  constructor(track: RemoteAudioTrack, participantIdentity: string) {
    this.participantIdentity = participantIdentity;
    // 16kHz mono — standard for STT
    this.stream = track.createStream(16000, 1);
    log.info(`AudioInput created for "${participantIdentity}" (trackSid=${track.sid})`);
  }

  get closed(): boolean {
    return this._closed;
  }

  /**
   * Async iterate over PCM16 buffers from this participant.
   * Each yielded Buffer is 16kHz mono PCM16 LE.
   */
  async *frames(): AsyncGenerator<Buffer> {
    for await (const frame of this.stream) {
      if (this._closed) break;
      this.frameCount++;
      if (this.frameCount === 1 || this.frameCount % 500 === 0) {
        log.info(`[${this.participantIdentity}] frame #${this.frameCount}`);
      }
      yield frame.toBuffer();
    }
    log.info(`[${this.participantIdentity}] frame iterator ended (total: ${this.frameCount})`);
  }

  /** Async iterate over AudioFrame objects. */
  async *audioFrames(): AsyncGenerator<AudioFrame> {
    for await (const frame of this.stream) {
      if (this._closed) break;
      yield frame;
    }
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.stream.close();
    log.debug(`AudioInput closed for participant "${this.participantIdentity}"`);
  }
}
