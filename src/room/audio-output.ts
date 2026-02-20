import { AudioSource, AudioFrame } from '@dtelecom/server-sdk-node';
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createLogger } from '../utils/logger';

const log = createLogger('AudioOutput');

/** Rate at which we write audio (48kHz mono, 20ms frames = 960 samples) */
const SAMPLE_RATE = 48000;
const CHANNELS = 1;
const FRAME_DURATION_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 960 at 48kHz

/** Pre-allocated silence frame */
const SILENCE = new Int16Array(SAMPLES_PER_FRAME);

export class AudioOutput {
  private source: AudioSource;
  private _playing = false;
  private _responding = false;
  private _stopped = false;
  private silenceInterval: ReturnType<typeof setInterval> | null = null;

  /** When set, raw PCM from TTS is saved to this directory as WAV files for debugging. */
  dumpDir: string | null = null;
  private dumpCounter = 0;

  constructor(source: AudioSource) {
    this.source = source;
  }

  get playing(): boolean {
    return this._playing;
  }

  /**
   * Mark the start of a multi-sentence response.
   * Suppresses silence injection between sentences so partial frames
   * in AudioSource's buffer don't get corrupted by interleaved silence.
   */
  beginResponse(): void {
    this._responding = true;
  }

  /** Mark the end of a response — re-enable silence keepalive. */
  endResponse(): void {
    this._responding = false;
  }

  /**
   * Start sparse silence keepalive to prevent the SFU from dropping the track.
   * With Opus DTX enabled, the encoder handles silence natively — we only need
   * an occasional packet to keep the SSRC alive.
   *
   * Waits for the RTP transport to be ready before sending — no frames are
   * wasted before DTLS is connected.
   */
  startSilence(): void {
    if (this.silenceInterval) return;

    const startKeepalive = () => {
      log.debug('Transport ready — sending initial silence + starting 3s keepalive');

      // Send one silence frame immediately so the SFU starts forwarding the
      // track right away — clients get TrackSubscribed without delay.
      this.sendSilenceFrame();

      this.silenceInterval = setInterval(() => {
        if (!this._playing && !this._responding && !this._stopped) {
          this.sendSilenceFrame();
        }
      }, 3000);
    };

    if (this.source.ready) {
      startKeepalive();
    } else {
      log.debug('Waiting for transport before starting silence keepalive...');
      this.source.onReady = () => startKeepalive();
    }
  }

  private sendSilenceFrame(): void {
    const frame = new AudioFrame(SILENCE, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME);
    this.source.captureFrame(frame).catch((err) => {
      log.warn('Failed to send silence frame:', err);
    });
  }

  /**
   * Write a PCM16 buffer to the audio output.
   * The buffer is split into 20ms frames and fed to AudioSource.
   */
  async writeBuffer(pcm16: Buffer): Promise<void> {
    this._playing = true;
    try {
      await this.writeFrames(pcm16);
    } finally {
      this._playing = false;
    }
  }

  /**
   * Write a stream of PCM16 buffers (from TTS) to the audio output.
   * Supports cancellation via AbortSignal.
   */
  async writeStream(
    stream: AsyncIterable<Buffer>,
    signal?: AbortSignal,
  ): Promise<void> {
    this._playing = true;
    const streamStart = performance.now();
    let chunkCount = 0;
    let totalBytes = 0;

    log.debug('writeStream: started');

    // Collect raw TTS chunks for WAV dump if enabled
    const rawChunks: Buffer[] | null = this.dumpDir ? [] : null;

    try {
      for await (const chunk of stream) {
        if (signal?.aborted) {
          log.debug(`writeStream: cancelled after ${chunkCount} chunks, ${(performance.now() - streamStart).toFixed(0)}ms`);
          break;
        }
        chunkCount++;
        totalBytes += chunk.byteLength;
        rawChunks?.push(Buffer.from(chunk));
        await this.writeFrames(chunk);
      }
    } finally {
      this._playing = false;
      const elapsed = performance.now() - streamStart;
      const audioDurationMs = (totalBytes / 2) / SAMPLE_RATE * 1000;
      log.info(
        `writeStream: done — ${chunkCount} chunks, ${totalBytes} bytes, ` +
        `audio=${audioDurationMs.toFixed(0)}ms, wall=${elapsed.toFixed(0)}ms`,
      );

      // Save raw TTS audio as WAV for debugging
      if (rawChunks && rawChunks.length > 0 && this.dumpDir) {
        try {
          if (!existsSync(this.dumpDir)) mkdirSync(this.dumpDir, { recursive: true });
          const filePath = join(this.dumpDir, `tts-raw-${++this.dumpCounter}.wav`);
          writeWav(filePath, rawChunks, SAMPLE_RATE);
          log.info(`writeStream: saved raw TTS to ${filePath}`);
        } catch (err) {
          log.warn('writeStream: failed to save WAV dump:', err);
        }
      }
    }
  }

  /**
   * Split a PCM16 buffer into 20ms frames and write them at real-time pace.
   * Partial frames at the end are sent directly — AudioSource handles
   * accumulation in its internal buffer.
   */
  private async writeFrames(pcm16: Buffer): Promise<void> {
    // Ensure aligned buffer for Int16Array.
    // ws library may deliver Buffers with odd byteOffset.
    const aligned = Buffer.alloc(pcm16.byteLength);
    pcm16.copy(aligned);
    const samples = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength / 2,
    );

    let offset = 0;
    while (offset < samples.length) {
      const end = Math.min(offset + SAMPLES_PER_FRAME, samples.length);
      const frameSamples = samples.subarray(offset, end);

      const frame = new AudioFrame(
        frameSamples,
        SAMPLE_RATE,
        CHANNELS,
        frameSamples.length,
      );

      await this.source.captureFrame(frame);

      // Only pace full frames — partial frames don't produce an Opus packet,
      // they just accumulate in AudioSource's buffer. Sleeping for them
      // causes audio to play slower than real-time.
      if (frameSamples.length === SAMPLES_PER_FRAME) {
        await sleep(FRAME_DURATION_MS);
      }

      offset = end;
    }
  }

  /**
   * Write silence frames for the given duration.
   * Used to pad the end of a response so the last Opus frame is fully flushed
   * and the audio doesn't cut off abruptly.
   */
  async writeSilence(durationMs: number): Promise<void> {
    const frameCount = Math.ceil(durationMs / FRAME_DURATION_MS);
    for (let i = 0; i < frameCount; i++) {
      const frame = new AudioFrame(SILENCE, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME);
      await this.source.captureFrame(frame);
      await sleep(FRAME_DURATION_MS);
    }
  }

  /** Flush any buffered audio in AudioSource */
  flush(): void {
    this.source.flush();
    this._playing = false;
  }

  /** Stop the silence keepalive */
  stop(): void {
    this._stopped = true;
    if (this.silenceInterval) {
      clearInterval(this.silenceInterval);
      this.silenceInterval = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Write a WAV file header + PCM data for debugging. */
function writeWav(filePath: string, pcmChunks: Buffer[], sampleRate: number): void {
  const dataSize = pcmChunks.reduce((sum, b) => sum + b.byteLength, 0);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  writeFileSync(filePath, header);
  for (const chunk of pcmChunks) {
    appendFileSync(filePath, chunk);
  }
}
