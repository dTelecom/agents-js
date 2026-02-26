/**
 * DtelecomSTT — real-time streaming STT via dTelecom STT server (realtime-stt-m2).
 *
 * Protocol:
 * - Connect to ws://<server>:<port> (address from options, no API key)
 * - Send config: {"type":"config","language":"en"} (or "auto" for Parakeet auto-detect)
 * - Wait for ready: {"type":"ready","client_id":"...","language":"en"}
 * - Send audio as binary PCM16 16kHz mono frames
 * - Receive transcriptions: {"type":"transcription","text":"...","is_final":true,"latency_ms":N}
 * - Receive VAD events: {"type":"vad_event","event":"speech_start"|"speech_end"}
 * - Keepalive via {"type":"ping"} / {"type":"pong"}
 * - Mid-session reconfigure: send {"type":"config","language":"es","model":"whisper"} at any time
 */

import WebSocket from 'ws';
import { BaseSTTStream } from '../core/base-stt-stream';
import type { STTPlugin, STTStream, STTStreamOptions, TranscriptionResult } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DtelecomSTT');

const KEEPALIVE_INTERVAL_MS = 5_000;

export interface DtelecomSTTOptions {
  /** WebSocket server URL, e.g. "ws://192.168.1.100:8765" */
  serverUrl: string;
  /** Initial language (default: "auto" for Parakeet auto-detect) */
  language?: string;
  /** Force Whisper model even if Parakeet supports the language */
  forceWhisper?: boolean;
}

export class DtelecomSTT implements STTPlugin {
  private readonly options: DtelecomSTTOptions;

  constructor(options: DtelecomSTTOptions) {
    if (!options.serverUrl) {
      throw new Error('DtelecomSTT requires a serverUrl');
    }
    this.options = options;
  }

  createStream(options?: STTStreamOptions): STTStream {
    const language = options?.language ?? this.options.language ?? 'auto';
    return new DtelecomSTTStream(this.options, language);
  }
}

class DtelecomSTTStream extends BaseSTTStream {
  private ws: WebSocket | null = null;
  private readonly serverUrl: string;
  private readonly forceWhisper: boolean;
  private _ready = false;
  private _closed = false;
  private pendingAudio: Buffer[] = [];
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private language: string;

  constructor(options: DtelecomSTTOptions, language: string) {
    super();
    this.serverUrl = options.serverUrl;
    this.language = language;
    this.forceWhisper = options.forceWhisper ?? false;
    this.connect();
  }

  sendAudio(pcm16: Buffer): void {
    if (this._closed) return;

    if (!this._ready) {
      this.pendingAudio.push(pcm16);
      return;
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm16);
    }
  }

  /**
   * Switch language mid-session.
   * Sends a reconfigure message to the server; clears buffers and updates model routing.
   */
  setLanguage(language: string, options?: { forceWhisper?: boolean }): void {
    if (this._closed) return;
    this.language = language;

    const config: Record<string, string> = { type: 'config', language };
    if (options?.forceWhisper) {
      config.model = 'whisper';
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(config));
      log.info(`Reconfiguring STT: language=${language}${options?.forceWhisper ? ', model=whisper' : ''}`);
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this.pendingAudio = [];
    this.stopKeepAlive();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.debug('DtelecomSTT stream closed');
  }

  private connect(): void {
    log.debug(`Connecting to dTelecom STT: ${this.serverUrl}`);

    this.ws = new WebSocket(this.serverUrl);

    this.ws.on('open', () => {
      log.info('dTelecom STT WebSocket connected');

      // Send initial config
      const config: Record<string, string> = { type: 'config', language: this.language };
      if (this.forceWhisper) {
        config.model = 'whisper';
      }
      this.ws!.send(JSON.stringify(config));
    });

    this.ws.on('message', (data, isBinary) => {
      if (isBinary) return; // Server only sends JSON text messages
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.error('Failed to parse dTelecom STT message:', err);
      }
    });

    this.ws.on('error', (err) => {
      log.error('dTelecom STT WebSocket error:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    this.ws.on('close', (code, reason) => {
      log.debug(`dTelecom STT WebSocket closed: ${code} ${reason.toString()}`);
      this._ready = false;
      this.stopKeepAlive();

      // Reconnect if not intentionally closed
      if (!this._closed) {
        log.info('dTelecom STT connection lost, reconnecting in 1s...');
        setTimeout(() => {
          if (!this._closed) this.connect();
        }, 1000);
      }
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'ready') {
      this.handleReady(msg);
    } else if (type === 'transcription') {
      this.handleTranscription(msg);
    } else if (type === 'vad_event') {
      this.handleVadEvent(msg);
    } else if (type === 'pong') {
      // Keepalive response — no action needed
    } else if (type === 'error') {
      const errData = msg.error;
      const errorMsg = (msg.message as string)
        || (typeof errData === 'string' ? errData : JSON.stringify(errData))
        || 'Unknown STT error';
      log.error(`dTelecom STT error: ${errorMsg}`);
      this.emit('error', new Error(errorMsg));
    }
  }

  private handleReady(msg: Record<string, unknown>): void {
    const clientId = msg.client_id as string | undefined;
    const lang = msg.language as string | undefined;
    log.info(`dTelecom STT ready: client_id=${clientId}, language=${lang}`);

    this._ready = true;

    // Flush pending audio
    for (const buf of this.pendingAudio) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(buf);
      }
    }
    this.pendingAudio = [];

    this.startKeepAlive();
  }

  private handleTranscription(msg: Record<string, unknown>): void {
    const text = (msg.text as string) ?? '';
    const isFinal = (msg.is_final as boolean) ?? false;
    const language = msg.language as string | undefined;
    const latencyMs = msg.latency_ms as number | undefined;

    if (!text) return;

    if (isFinal && latencyMs !== undefined) {
      log.info(`stt_final: ${latencyMs.toFixed(0)}ms "${text.slice(0, 50)}"`);
    }

    this.emit('transcription', {
      text,
      isFinal,
      language,
      sttDuration: isFinal ? latencyMs : undefined,
    } satisfies TranscriptionResult);
  }

  private handleVadEvent(msg: Record<string, unknown>): void {
    const event = msg.event as string;
    log.debug(`VAD event: ${event}`);

    if (event === 'speech_start') {
      // Emit empty non-final transcription to signal speech detected.
      // Note: barge-in in the pipeline requires non-empty text, so this won't
      // trigger it directly. Actual interim transcriptions that follow will.
      this.emit('transcription', {
        text: '',
        isFinal: false,
      } satisfies TranscriptionResult);
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
