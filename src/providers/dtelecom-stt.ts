/**
 * DtelecomSTT — real-time streaming STT via dTelecom STT server (realtime-stt-m2).
 *
 * Protocol:
 * - Connect to the authenticated /v1/stream endpoint (address from options)
 * - Send config with session_key and language; partials/smart_turn are explicit opt-ins
 * - Wait for ready: {"type":"ready","client_id":"...","language":"en"}
 * - Send audio as binary PCM16 16kHz mono frames
 * - Receive transcriptions: {"type":"transcription","text":"...","is_final":true,"latency_ms":N}
 * - Receive optional transcription_partial / partial_end and smart_turn ready status
 * - Receive VAD events: {"type":"vad_event","event":"speech_start"|"speech_end"}
 * - Keepalive via {"type":"ping"} / {"type":"pong"}
 * - Mid-session reconfigure: send {"type":"config","language":"es","model":"whisper"} at any time
 */

import WebSocket from 'ws';
import { BaseSTTStream } from '../core/base-stt-stream';
import type { STTPlugin, STTStream, STTStreamOptions, TranscriptionResult, STTPartialEnd } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DtelecomSTT');

const KEEPALIVE_INTERVAL_MS = 5_000;

export interface DtelecomSTTOptions {
  /** Server base URL, e.g. "https://stt-xxx.dtel.network" */
  serverUrl: string;
  /** JWT session key from x402 gateway */
  sessionKey: string;
  /** Initial language (default: "auto" for Parakeet auto-detect) */
  language?: string;
  /** Force Whisper model even if Parakeet supports the language */
  forceWhisper?: boolean;
  /** Receive replaceable provisional transcripts. Omitted by default. */
  partials?: boolean;
  /** Opt-in semantic endpointing; inspect ready.smartTurn for activation/fallback. */
  smartTurn?: boolean;
}

export class DtelecomSTT implements STTPlugin {
  private readonly options: DtelecomSTTOptions;

  constructor(options: DtelecomSTTOptions) {
    if (!options.serverUrl) {
      throw new Error('DtelecomSTT requires a serverUrl');
    }
    if (!options.sessionKey) {
      throw new Error('DtelecomSTT requires a sessionKey');
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
  private readonly sessionKey: string;
  private readonly forceWhisper: boolean;
  private readonly partials: boolean | undefined;
  private readonly smartTurn: boolean | undefined;
  private _ready = false;
  private _closed = false;
  private pendingAudio: Buffer[] = [];
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private language: string;

  constructor(options: DtelecomSTTOptions, language: string) {
    super();
    this.serverUrl = options.serverUrl;
    this.sessionKey = options.sessionKey;
    this.language = language;
    this.forceWhisper = options.forceWhisper ?? false;
    this.partials = options.partials;
    this.smartTurn = options.smartTurn;
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

    const config: Record<string, string | boolean> = { type: 'config', language, ...this.featureConfig() };
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
    // Use /v1/stream auth path, convert https:// to wss://
    const url = new URL(this.serverUrl);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    if (!['ws:', 'wss:'].includes(url.protocol) || !['/', '/v1/stream'].includes(url.pathname)) {
      throw new Error('Invalid dTelecom STT server URL');
    }
    url.pathname = '/v1/stream';
    url.hash = '';
    const wsUrl = url.toString();

    log.debug(`Connecting to dTelecom STT: ${wsUrl}`);

    this.ws = new WebSocket(wsUrl);

    this.ws.on('open', () => {
      log.info('dTelecom STT WebSocket connected');

      // Send initial config with session_key
      const config: Record<string, string | boolean> = {
        type: 'config',
        language: this.language,
        session_key: this.sessionKey,
        ...this.featureConfig(),
      };
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
    if (this._closed) return;
    const type = msg.type as string;

    if (type === 'ready') {
      this.handleReady(msg);
    } else if (type === 'transcription') {
      this.handleTranscription(msg);
    } else if (type === 'transcription_partial' && this.partials) {
      if (typeof msg.utterance_id !== 'string' || typeof msg.text !== 'string'
        || typeof msg.revision !== 'number' || typeof msg.window_start_seconds !== 'number') return;
      const result: TranscriptionResult = {
        text: msg.text, isFinal: false, language: msg.language as string | undefined,
        utteranceId: msg.utterance_id, revision: msg.revision,
        windowStartSeconds: msg.window_start_seconds, provisional: true, replacePrevious: true,
      };
      this.emit('transcription_partial', result);
      this.emit('transcription', result);
    } else if (type === 'partial_end' && this.partials) {
      if (typeof msg.utterance_id !== 'string'
        || !['finalizing', 'discarded', 'replaced', 'reconfigured'].includes(msg.reason as string)) return;
      this.emit('partial_end', {
        utteranceId: msg.utterance_id, reason: msg.reason as STTPartialEnd['reason'],
      });
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
    this.emit('ready', {
      clientId, language: lang,
      ...(msg.smart_turn === 'active' || msg.smart_turn === 'acoustic_fallback'
        ? { smartTurn: msg.smart_turn } : {}),
    });

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
      ...(typeof msg.utterance_id === 'string' ? { utteranceId: msg.utterance_id } : {}),
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

  private featureConfig(): Record<string, boolean> {
    return {
      ...(this.partials === undefined ? {} : { partials: this.partials }),
      ...(this.smartTurn === undefined ? {} : { smart_turn: this.smartTurn }),
    };
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
