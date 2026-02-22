/**
 * CartesiaTTS — real-time streaming TTS via Cartesia WebSocket API.
 *
 * Protocol:
 * - Connect to wss://api.cartesia.ai/tts/websocket?api_key=...&cartesia_version=...
 * - Send JSON: { model_id, transcript, voice: { mode: "id", id }, output_format, context_id }
 * - Receive JSON: { type: "chunk", data: "<base64 PCM>" } — audio data
 * - Receive JSON: { type: "done", context_id } — synthesis complete
 * - Audio is base64-encoded PCM16 LE at the requested sample rate
 *
 * Uses a persistent WebSocket connection to avoid per-sentence handshake overhead.
 * Each synthesize() call uses a unique context_id for multiplexing.
 */

import WebSocket from 'ws';
import type { TTSPlugin } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('CartesiaTTS');

const CARTESIA_WS_BASE = 'wss://api.cartesia.ai/tts/websocket';
const DEFAULT_API_VERSION = '2024-06-10';
const DEFAULT_MODEL = 'sonic-3';
/** Pipeline operates at 48kHz — matches Opus/WebRTC native rate, no resampling */
const DEFAULT_SAMPLE_RATE = 48000;
/** Reconnect after idle timeout (Cartesia closes after 5 min idle) */
const RECONNECT_DELAY_MS = 1000;

export interface CartesiaTTSOptions {
  apiKey: string;
  /** Cartesia voice ID */
  voiceId: string;
  /** Model ID (default: 'sonic-3') */
  modelId?: string;
  /** Output sample rate in Hz (default: 16000) */
  sampleRate?: number;
  /** API version (default: '2024-06-10') */
  apiVersion?: string;
  /** Language code (default: 'en') */
  language?: string;
  /** Speech speed multiplier, 0.6-1.5 (default: 1.0). Sonic-3 only. */
  speed?: number;
  /** Emotion string (e.g. 'friendly', 'calm'). Sonic-3 only. */
  emotion?: string;
}

/** Per-context state for tracking an in-flight synthesis. */
interface ContextState {
  chunks: Buffer[];
  done: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

export class CartesiaTTS implements TTSPlugin {
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly modelId: string;
  private readonly sampleRate: number;
  private readonly apiVersion: string;
  private readonly language?: string;
  private readonly speed: number | undefined;
  private readonly emotion: string | undefined;

  private ws: WebSocket | null = null;
  private _connected = false;
  private connectPromise: Promise<void> | null = null;
  /** Active contexts keyed by context_id */
  private contexts = new Map<string, ContextState>();
  private contextCounter = 0;

  constructor(options: CartesiaTTSOptions) {
    if (!options.apiKey) {
      throw new Error('CartesiaTTS requires an apiKey');
    }
    if (!options.voiceId) {
      throw new Error('CartesiaTTS requires a voiceId');
    }
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId;
    this.modelId = options.modelId ?? DEFAULT_MODEL;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.language = options.language;
    this.speed = options.speed;
    this.emotion = options.emotion;
  }

  /** Close the WebSocket connection to allow clean process exit. */
  close(): void {
    if (this.ws) {
      log.debug('Closing Cartesia WebSocket');
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
    this.connectPromise = null;
  }

  /** Pre-connect the WebSocket so first synthesize() doesn't pay connection cost. */
  async warmup(): Promise<void> {
    log.info('Warming up TTS connection...');
    const start = performance.now();
    try {
      await this.ensureConnection();
      log.info(`TTS warmup complete in ${(performance.now() - start).toFixed(0)}ms`);
    } catch (err) {
      log.warn('TTS warmup failed (non-fatal):', err);
    }
  }

  async *synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    log.debug(`Synthesizing: "${text.slice(0, 60)}"`);

    await this.ensureConnection();

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Cartesia WebSocket not connected');
    }

    const contextId = `ctx-${++this.contextCounter}-${Date.now()}`;
    const ctx: ContextState = { chunks: [], done: false, error: null, wake: null };
    this.contexts.set(contextId, ctx);

    // Build request
    const request: Record<string, unknown> = {
      model_id: this.modelId,
      transcript: text,
      voice: { mode: 'id', id: this.voiceId },
      output_format: {
        container: 'raw',
        encoding: 'pcm_s16le',
        sample_rate: this.sampleRate,
      },
      context_id: contextId,
      continue: false,
    };

    if (this.language) {
      request.language = this.language;
    }

    // Sonic-3 generation config
    if (this.speed !== undefined || this.emotion !== undefined) {
      const genConfig: Record<string, unknown> = {};
      if (this.speed !== undefined) genConfig.speed = this.speed;
      if (this.emotion !== undefined) genConfig.emotion = this.emotion;
      request.generation_config = genConfig;
    }

    // Handle abort — cancel the context on the server
    const onAbort = () => {
      ctx.done = true;
      ctx.wake?.();
      // Send cancel to server so it stops generating
      if (this.ws?.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ context_id: contextId, cancel: true }));
        } catch {
          // Ignore send errors during cancellation
        }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Send synthesis request
    this.ws.send(JSON.stringify(request));

    // Yield audio chunks as they arrive
    try {
      while (true) {
        if (signal?.aborted) break;
        if (ctx.error) throw ctx.error;

        if (ctx.chunks.length > 0) {
          yield ctx.chunks.shift()!;
          continue;
        }

        if (ctx.done) break;

        // Wait for next chunk or done signal
        await new Promise<void>((resolve) => {
          ctx.wake = resolve;
        });
        ctx.wake = null;
      }

      // Drain remaining chunks
      while (ctx.chunks.length > 0) {
        yield ctx.chunks.shift()!;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.contexts.delete(contextId);
    }
  }

  /** Ensure the persistent WebSocket is connected. */
  private ensureConnection(): Promise<void> {
    if (this._connected && this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    // Deduplicate concurrent connection attempts
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const url = `${CARTESIA_WS_BASE}?api_key=${this.apiKey}&cartesia_version=${this.apiVersion}`;
      log.debug('Connecting to Cartesia...');

      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        this._connected = true;
        this.connectPromise = null;
        log.info('Cartesia WebSocket connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          log.error('Failed to parse Cartesia message:', err);
        }
      });

      this.ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error('Cartesia WebSocket error:', error);
        // Propagate error to all active contexts
        for (const ctx of this.contexts.values()) {
          ctx.error = error;
          ctx.wake?.();
        }
        this._connected = false;
        this.connectPromise = null;
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        log.debug(`Cartesia WebSocket closed: ${code} ${reason.toString()}`);
        this._connected = false;
        this.connectPromise = null;
        // Mark all active contexts as done
        for (const ctx of this.contexts.values()) {
          ctx.done = true;
          ctx.wake?.();
        }
      });
    });

    return this.connectPromise;
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const contextId = msg.context_id as string | undefined;
    if (!contextId) return;

    const ctx = this.contexts.get(contextId);
    if (!ctx) return; // Stale context — already cleaned up

    const type = msg.type as string;

    if (type === 'chunk') {
      const b64 = msg.data as string;
      if (b64) {
        const pcm = Buffer.from(b64, 'base64');
        ctx.chunks.push(pcm);
        ctx.wake?.();
      }
    } else if (type === 'done') {
      log.debug(`Cartesia synthesis done for ${contextId} (${ctx.chunks.length} chunks pending)`);
      ctx.done = true;
      ctx.wake?.();
    } else if (type === 'error') {
      const errorMsg = msg.error as string ?? 'Unknown Cartesia error';
      log.error(`Cartesia error for ${contextId}: ${errorMsg}`);
      ctx.error = new Error(`Cartesia TTS error: ${errorMsg}`);
      ctx.wake?.();
    }
  }
}
