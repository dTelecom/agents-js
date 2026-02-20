import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AudioOutput } from '../src/room/audio-output';

// Suppress logger output in tests
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// ─── Mock AudioSource & AudioFrame ──────────────────────────────────────────

interface CapturedFrame {
  samples: Int16Array;
  sampleRate: number;
  channels: number;
  samplesPerChannel: number;
  capturedAt: number;
}

class MockAudioSource {
  readonly frames: CapturedFrame[] = [];
  private _flushed = 0;
  private _onReady: (() => void) | null = null;

  /** Simulates transport readiness (DTLS connected). Defaults to true for most tests. */
  ready = true;

  set onReady(cb: (() => void) | null) {
    if (cb && this.ready) {
      cb();
      return;
    }
    this._onReady = cb;
  }

  /** Simulate transport becoming ready (call from tests). */
  makeReady(): void {
    this.ready = true;
    if (this._onReady) {
      this._onReady();
      this._onReady = null;
    }
  }

  get flushCount(): number {
    return this._flushed;
  }

  async captureFrame(frame: any): Promise<void> {
    this.frames.push({
      samples: new Int16Array(frame.data),
      sampleRate: frame.sampleRate,
      channels: frame.channels,
      samplesPerChannel: frame.samplesPerChannel,
      capturedAt: performance.now(),
    });
  }

  flush(): void {
    this._flushed++;
  }
}

// Mock the server-sdk-node module
vi.mock('@dtelecom/server-sdk-node', () => ({
  AudioSource: vi.fn(),
  AudioFrame: vi.fn().mockImplementation(
    (data: Int16Array, sampleRate: number, channels: number, samplesPerChannel: number) => ({
      data: new Int16Array(data),
      sampleRate,
      channels,
      samplesPerChannel,
    }),
  ),
}));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** 48kHz, 20ms frame = 960 samples */
const FRAME = 960;

/** Create a PCM16 buffer of `numSamples` with optional fill value. */
function makePCM(numSamples: number, fill = 1000): Buffer {
  const buf = Buffer.alloc(numSamples * 2);
  const view = new Int16Array(buf.buffer, buf.byteOffset, numSamples);
  view.fill(fill);
  return buf;
}

/** Async generator that yields buffers. */
async function* makeStream(chunks: Buffer[]): AsyncGenerator<Buffer> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('AudioOutput', () => {
  let source: MockAudioSource;
  let output: AudioOutput;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    source = new MockAudioSource();
    output = new AudioOutput(source as any);
  });

  afterEach(() => {
    output.stop();
    vi.useRealTimers();
  });

  describe('writeBuffer', () => {
    it('splits buffer into 960-sample (20ms @ 48kHz) frames', async () => {
      const pcm = makePCM(FRAME * 2);
      await output.writeBuffer(pcm);

      expect(source.frames).toHaveLength(2);
      expect(source.frames[0].samplesPerChannel).toBe(FRAME);
      expect(source.frames[1].samplesPerChannel).toBe(FRAME);
    });

    it('sends partial last frame to AudioSource', async () => {
      // 1440 samples = 1 full frame (960) + 1 partial frame (480)
      const pcm = makePCM(FRAME + 480, 5000);
      await output.writeBuffer(pcm);

      expect(source.frames).toHaveLength(2);
      expect(source.frames[0].samplesPerChannel).toBe(FRAME);
      expect(source.frames[1].samplesPerChannel).toBe(480);
      expect(source.frames[0].samples[0]).toBe(5000);
      expect(source.frames[1].samples[0]).toBe(5000);
      expect(source.frames[1].samples[479]).toBe(5000);
    });

    it('sets playing=false after write', async () => {
      expect(output.playing).toBe(false);
      await output.writeBuffer(makePCM(FRAME));
      expect(output.playing).toBe(false);
    });

    it('handles buffer with odd byteOffset (alignment fix)', async () => {
      const backing = Buffer.alloc(FRAME * 2 + 1);
      const oddOffset = Buffer.from(backing.buffer, 1, FRAME * 2);
      for (let i = 0; i < FRAME * 2; i++) oddOffset[i] = i % 256;

      await output.writeBuffer(oddOffset);
      expect(source.frames.length).toBeGreaterThan(0);
    });
  });

  describe('writeStream', () => {
    it('writes multiple chunks sequentially', async () => {
      const chunks = [makePCM(FRAME), makePCM(FRAME), makePCM(FRAME)];
      await output.writeStream(makeStream(chunks));

      // 3 chunks of exactly 1 frame each
      expect(source.frames).toHaveLength(3);
    });

    it('stops on abort signal', async () => {
      const controller = new AbortController();
      let yieldCount = 0;

      async function* slowStream(): AsyncGenerator<Buffer> {
        for (let i = 0; i < 10; i++) {
          yieldCount++;
          yield makePCM(FRAME);
          if (i === 1) controller.abort();
        }
      }

      await output.writeStream(slowStream(), controller.signal);
      expect(yieldCount).toBeLessThan(10);
      expect(output.playing).toBe(false);
    });

    it('sets playing=false after stream ends', async () => {
      await output.writeStream(makeStream([makePCM(FRAME)]));
      expect(output.playing).toBe(false);
    });
  });

  describe('partial frames', () => {
    it('sends partial last frame directly to AudioSource', async () => {
      // 1500 samples = 1 full frame (960) + 1 partial frame (540)
      const chunks = [makePCM(FRAME + 540, 7777)];
      await output.writeStream(makeStream(chunks));

      expect(source.frames).toHaveLength(2);
      expect(source.frames[0].samplesPerChannel).toBe(FRAME);
      expect(source.frames[1].samplesPerChannel).toBe(540);
      expect(source.frames[1].samples[0]).toBe(7777);
    });

    it('each chunk is split independently', async () => {
      // 3 sub-frame chunks — all partial, no full frames
      const chunks = [makePCM(600), makePCM(600), makePCM(700)];
      await output.writeStream(makeStream(chunks));

      expect(source.frames).toHaveLength(3);
      expect(source.frames[0].samplesPerChannel).toBe(600);
      expect(source.frames[1].samplesPerChannel).toBe(600);
      expect(source.frames[2].samplesPerChannel).toBe(700);
    });

    it('aligned chunks produce only full frames', async () => {
      // 3 chunks of exactly 2 frames each = 6 frames total
      const chunks = [makePCM(FRAME * 2), makePCM(FRAME * 2), makePCM(FRAME * 2)];
      await output.writeStream(makeStream(chunks));

      expect(source.frames).toHaveLength(6);
      for (const frame of source.frames) {
        expect(frame.samplesPerChannel).toBe(FRAME);
      }
    });

    it('small chunks sent as single partial frames', async () => {
      const chunks = [makePCM(300), makePCM(300), makePCM(600)];
      await output.writeStream(makeStream(chunks));

      expect(source.frames).toHaveLength(3);
      expect(source.frames[0].samplesPerChannel).toBe(300);
      expect(source.frames[1].samplesPerChannel).toBe(300);
      expect(source.frames[2].samplesPerChannel).toBe(600);
    });
  });

  describe('pacing', () => {
    it('sleeps ~20ms between frames', async () => {
      vi.useRealTimers();

      const pcm = makePCM(FRAME * 3); // 3 full frames
      const start = performance.now();
      await output.writeBuffer(pcm);
      const elapsed = performance.now() - start;

      // 3 frames × ~20ms = ~60ms
      expect(elapsed).toBeGreaterThan(40);
      expect(elapsed).toBeLessThan(200);
    });

    it('does not burst frames — gap between consecutive frames', async () => {
      vi.useRealTimers();

      const pcm = makePCM(FRAME * 3); // 3 frames
      await output.writeBuffer(pcm);

      for (let i = 1; i < source.frames.length; i++) {
        const gap = source.frames[i].capturedAt - source.frames[i - 1].capturedAt;
        expect(gap).toBeGreaterThan(5);
        expect(gap).toBeLessThan(50);
      }
    });

    it('no burst after TTS latency — lazy init prevents overdue frames', async () => {
      vi.useRealTimers();

      async function* delayedStream(): AsyncGenerator<Buffer> {
        await new Promise((r) => setTimeout(r, 200)); // TTS latency
        yield makePCM(FRAME * 3); // 3 frames arrive at once
      }

      await output.writeStream(delayedStream());

      // All paced frames should be ~20ms apart
      const pacedFrames = source.frames.filter((_, i) => i < source.frames.length - 1 || source.frames.length <= 3);
      for (let i = 1; i < Math.min(pacedFrames.length, 3); i++) {
        const gap = pacedFrames[i].capturedAt - pacedFrames[i - 1].capturedAt;
        expect(gap).toBeGreaterThan(5);
        expect(gap).toBeLessThan(50);
      }
    });

    it('pacing is continuous across multiple chunks', async () => {
      vi.useRealTimers();

      // 3 chunks of 2 frames each = 6 paced frames
      const chunks = [makePCM(FRAME * 2), makePCM(FRAME * 2), makePCM(FRAME * 2)];
      await output.writeStream(makeStream(chunks));

      expect(source.frames).toHaveLength(6);

      const totalTime = source.frames[5].capturedAt - source.frames[0].capturedAt;
      expect(totalTime).toBeGreaterThan(80);
      expect(totalTime).toBeLessThan(250);

      for (let i = 1; i < source.frames.length; i++) {
        const gap = source.frames[i].capturedAt - source.frames[i - 1].capturedAt;
        expect(gap).toBeGreaterThan(5);
      }
    });

    it('partial frames skip sleep — only full frames are paced', async () => {
      vi.useRealTimers();

      // 1500 samples per chunk = 1 full frame (960) + 1 partial (540)
      // Only full frames sleep 20ms, partial frames are sent immediately
      // 3 chunks × 1 full frame = 3 sleeps = ~60ms (not 120ms)
      const chunks = [makePCM(FRAME + 540), makePCM(FRAME + 540), makePCM(FRAME + 540)];
      const start = performance.now();
      await output.writeStream(makeStream(chunks));
      const elapsed = performance.now() - start;

      // 3 full frames × 20ms = 60ms + overhead
      expect(elapsed).toBeGreaterThan(40);
      expect(elapsed).toBeLessThan(200);
    });
  });

  describe('silence keepalive', () => {
    it('sends silence frames when not playing', async () => {
      output.startSilence();
      // Silence keepalive fires every 3s (sparse, Opus DTX handles silence natively)
      await vi.advanceTimersByTimeAsync(10000);

      expect(source.frames.length).toBeGreaterThanOrEqual(3);
      for (const frame of source.frames) {
        expect(frame.samples.every((s) => s === 0)).toBe(true);
      }
    });

    it('suppresses silence during responding (_responding=true)', async () => {
      output.startSilence();
      // 1 immediate silence frame sent by startSilence()
      const initialFrames = source.frames.length;
      output.beginResponse();

      await vi.advanceTimersByTimeAsync(10000);
      // No additional frames while responding
      expect(source.frames).toHaveLength(initialFrames);

      output.endResponse();
      await vi.advanceTimersByTimeAsync(4000);
      expect(source.frames.length).toBeGreaterThan(0);
    });

    it('defers silence until transport is ready', async () => {
      source.ready = false;
      output.startSilence();

      // No frames sent while transport is not ready
      await vi.advanceTimersByTimeAsync(5000);
      expect(source.frames).toHaveLength(0);

      // Transport becomes ready — immediate frame + keepalive starts
      source.makeReady();
      expect(source.frames).toHaveLength(1);
      expect(source.frames[0].samples.every((s) => s === 0)).toBe(true);

      await vi.advanceTimersByTimeAsync(4000);
      expect(source.frames.length).toBeGreaterThan(1);
    });

    it('does not double-start silence interval', () => {
      output.startSilence();
      output.startSilence();
      // No error thrown
    });
  });

  describe('flush', () => {
    it('flushes AudioSource and sets playing to false', () => {
      output.flush();
      expect(output.playing).toBe(false);
      expect(source.flushCount).toBe(1);
    });
  });

  describe('stop', () => {
    it('clears silence interval', async () => {
      output.startSilence();
      await vi.advanceTimersByTimeAsync(60);
      const framesBeforeStop = source.frames.length;

      output.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(source.frames.length).toBe(framesBeforeStop);
    });
  });

  describe('data integrity', () => {
    it('preserves sample values through writeBuffer', async () => {
      const pcm = makePCM(FRAME, 12345);
      await output.writeBuffer(pcm);

      expect(source.frames).toHaveLength(1);
      expect(source.frames[0].samples[0]).toBe(12345);
      expect(source.frames[0].samples[FRAME - 1]).toBe(12345);
    });

    it('preserves sample values across multiple frames', async () => {
      const buf = Buffer.alloc(FRAME * 2 * 2); // 2 frames × 2 bytes per sample
      const view = new Int16Array(buf.buffer, buf.byteOffset, FRAME * 2);
      view.fill(1111, 0, FRAME);
      view.fill(2222, FRAME, FRAME * 2);

      await output.writeBuffer(buf);

      expect(source.frames).toHaveLength(2);
      expect(source.frames[0].samples[0]).toBe(1111);
      expect(source.frames[1].samples[0]).toBe(2222);
    });

    it('all frames use correct sample rate and channels', async () => {
      await output.writeBuffer(makePCM(FRAME * 3));

      for (const frame of source.frames) {
        expect(frame.sampleRate).toBe(48000);
        expect(frame.channels).toBe(1);
      }
    });
  });
});
