/**
 * DtelecomTTS — real-time streaming TTS via dTelecom TTS server (realtime-tts-m2).
 *
 * Protocol:
 * - Connect to ws://<server>:<port> (address from options, no API key)
 * - Send config: {"config":{"voice":"af_heart","lang_code":"a","speed":1.0}}
 * - Send text: {"text":"Hello world"} — uses config defaults
 * - Send text with per-message override: {"text":"Hola","voice":"ef_dora","lang_code":"e","speed":1.0}
 * - Receive: {"type":"generating","text":"..."} then binary PCM16 48kHz chunks, then {"type":"done"}
 * - Cancel: {"type":"clear"} → {"type":"cleared"}
 *
 * Key differences from DeepgramTTS:
 * - Single WebSocket connection (not per-language pool)
 * - Per-message voice/language switching instead of separate connections
 * - Server outputs 48kHz PCM16 (resampled from Kokoro's native 24kHz)
 * - Uses SSML <lang> tags to route text segments to correct voice (same as DeepgramTTS)
 */

import WebSocket from 'ws';
import { parseLangSegments } from './deepgram-tts';
import type { TTSPlugin } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DtelecomTTS');

export interface VoiceConfig {
  voice: string;
  langCode: string;
}

export interface DtelecomTTSOptions {
  /** WebSocket server URL, e.g. "ws://192.168.1.100:8766" */
  serverUrl: string;
  /** Voice config per language: { en: { voice: "af_heart", langCode: "a" }, es: { voice: "bf_emma", langCode: "b" } } */
  voices: Record<string, VoiceConfig>;
  /** Default language code (default: "en") */
  defaultLanguage?: string;
  /** Speech speed multiplier (default: 1.0) */
  speed?: number;
}

/** Per-request state for tracking an in-flight synthesis. */
interface FlushState {
  chunks: Buffer[];
  done: boolean;
  cleared: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

export class DtelecomTTS implements TTSPlugin {
  private readonly serverUrl: string;
  private readonly voices: Record<string, VoiceConfig>;
  private readonly defaultLang: string;
  private readonly speed: number;

  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private flushState: FlushState | null = null;

  /** Default language code for untagged text (e.g. 'en'). */
  get defaultLanguage(): string {
    return this.defaultLang;
  }

  constructor(options: DtelecomTTSOptions) {
    if (!options.serverUrl) {
      throw new Error('DtelecomTTS requires a serverUrl');
    }
    if (!options.voices || Object.keys(options.voices).length === 0) {
      throw new Error('DtelecomTTS requires at least one voice config');
    }

    this.serverUrl = options.serverUrl;
    this.voices = { ...options.voices };
    this.defaultLang = options.defaultLanguage ?? Object.keys(this.voices)[0];
    this.speed = options.speed ?? 1.0;
  }

  /** Pre-connect WebSocket to TTS server. */
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

  /** Close WebSocket connection. */
  close(): void {
    if (this.ws) {
      log.debug('Closing TTS WebSocket');
      this.ws.close();
      this.ws = null;
    }
    this.connectPromise = null;
    this.flushState = null;
  }

  /** Strip SSML lang tags from text for display/events. */
  cleanText(text: string): string {
    return parseLangSegments(text, this.defaultLang)
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async *synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (signal?.aborted) return;

    const rawSegments = parseLangSegments(text, this.defaultLang);

    // Merge punctuation-only segments into the previous segment.
    // After <lang> tag splitting, trailing punctuation (e.g. "?" or ".") can end up
    // in its own segment. It belongs to the previous phrase for correct intonation.
    const segments: typeof rawSegments = [];
    for (const seg of rawSegments) {
      if (!seg.text.trim()) continue;
      if (!/\p{L}/u.test(seg.text) && segments.length > 0) {
        segments[segments.length - 1].text += seg.text;
      } else {
        segments.push(seg);
      }
    }

    // 200ms silence buffer for gaps between language switches
    // PCM16 48kHz mono: 48000 * 0.2 * 2 = 19200 bytes
    const silenceBytes = Math.round(48000 * 0.2) * 2;
    const silence = Buffer.alloc(silenceBytes);

    let prevLang: string | null = null;
    for (const segment of segments) {
      if (signal?.aborted) break;
      const lang = this.voices[segment.lang] ? segment.lang : this.defaultLang;

      // Insert silence when switching between languages
      if (prevLang !== null && lang !== prevLang) {
        yield silence;
      }
      prevLang = lang;

      yield* this.synthesizeSegment(lang, segment.text, signal);
    }
  }

  private async *synthesizeSegment(
    lang: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    await this.ensureConnection();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('dTelecom TTS WebSocket not connected');
    }

    const state: FlushState = { chunks: [], done: false, cleared: false, error: null, wake: null };
    this.flushState = state;

    // Handle abort — send clear to cancel
    const onAbort = () => {
      state.done = true;
      state.wake?.();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'clear' }));
        } catch {
          // Ignore send errors during cancellation
        }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Send text with per-message voice/language override
    const voiceConfig = this.voices[lang];
    const msg: Record<string, unknown> = { text };
    if (voiceConfig) {
      msg.voice = voiceConfig.voice;
      msg.lang_code = voiceConfig.langCode;
      msg.speed = this.speed;
    }
    log.info(`TTS send [${lang}]: voice=${voiceConfig?.voice ?? 'default'} lang_code=${voiceConfig?.langCode ?? 'default'} "${text.slice(0, 60)}"`)
    ws.send(JSON.stringify(msg));

    try {
      while (true) {
        if (signal?.aborted) break;
        if (state.error) throw state.error;

        if (state.chunks.length > 0) {
          yield state.chunks.shift()!;
          continue;
        }

        if (state.done) break;

        // Wait for next chunk or done signal
        await new Promise<void>((resolve) => {
          state.wake = resolve;
        });
        state.wake = null;
      }

      // Drain remaining chunks
      while (state.chunks.length > 0) {
        yield state.chunks.shift()!;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.flushState = null;
    }
  }

  /** Ensure a WebSocket connection exists and is open. */
  private ensureConnection(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    // Deduplicate concurrent connection attempts
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      log.debug(`Connecting to dTelecom TTS: ${this.serverUrl}`);

      const ws = new WebSocket(this.serverUrl);

      ws.on('open', () => {
        this.ws = ws;
        this.connectPromise = null;

        // Send initial config with default voice
        const defaultVoice = this.voices[this.defaultLang];
        if (defaultVoice) {
          ws.send(JSON.stringify({
            config: {
              voice: defaultVoice.voice,
              lang_code: defaultVoice.langCode,
              speed: this.speed,
            },
          }));
        }

        log.info('dTelecom TTS WebSocket connected');
        resolve();
      });

      ws.on('message', (data, isBinary) => {
        const state = this.flushState;
        if (!state) return;

        if (isBinary) {
          // Binary frame = raw PCM16 48kHz audio (server resamples from Kokoro's 24kHz)
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          state.chunks.push(buf);
          state.wake?.();
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'done') {
              state.done = true;
              state.wake?.();
            } else if (msg.type === 'cleared') {
              state.cleared = true;
              state.done = true;
              state.wake?.();
            } else if (msg.type === 'generating') {
              log.debug(`TTS generating: "${(msg.text as string)?.slice(0, 40)}"`);
            } else if (msg.type === 'error') {
              const errorMsg = (msg.message as string) || 'Unknown TTS error';
              log.error(`dTelecom TTS error: ${errorMsg}`);
              state.error = new Error(errorMsg);
              state.wake?.();
            }
          } catch {
            log.warn('Failed to parse dTelecom TTS message');
          }
        }
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error('dTelecom TTS WebSocket error:', error);
        const state = this.flushState;
        if (state) {
          state.error = error;
          state.wake?.();
        }
        this.ws = null;
        this.connectPromise = null;
        reject(error);
      });

      ws.on('close', (code, reason) => {
        log.debug(`dTelecom TTS WebSocket closed: ${code} ${reason.toString()}`);
        this.ws = null;
        this.connectPromise = null;
        const state = this.flushState;
        if (state) {
          state.done = true;
          state.wake?.();
        }
      });
    });

    return this.connectPromise;
  }
}
