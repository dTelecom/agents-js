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
 * - Extension: send {"type":"extend","session_key":"..."} with a new key before the session expires
 * - Finalize: send {"type":"finalize"} to end the current utterance now; sent only when the ready
 *   message carries finalize: true (older servers do not, and finalize() does nothing there)
 *
 * Two ways to authorise: a fixed `serverUrl` + `sessionKey` (x402), or `cloud`, a dTelecom Cloud
 * client. With `cloud`, every stream (one per participant) opens its own STT session, linked to
 * the agent's WebRTC session, and extends it before it runs out.
 *
 * A session key serves one connection. After a disconnect, cloud mode opens a new session; x402
 * mode asks `getSessionKey` for a new key, or reports an error and stops without it.
 */

import WebSocket from 'ws';
import type { CloudClient } from '@dtelecom/server-sdk-js';
import { CloudSpeechSession, type CloudSTTSessionOptions } from './cloud-speech-session';
import { toStreamUrl, type SessionKeyRefresh } from './stream-url';
import { BaseSTTStream } from '../core/base-stt-stream';
import type { STTPlugin, STTStream, STTStreamOptions, TranscriptionResult, STTPartialEnd } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DtelecomSTT');

const KEEPALIVE_INTERVAL_MS = 5_000;
/** Audio kept while (re)connecting: 5 s of 16 kHz PCM16; the oldest is dropped first. */
const MAX_PENDING_BYTES = 5 * 16_000 * 2;
const RECONNECT_FIRST_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface DtelecomSTTOptions {
  /** dTelecom Cloud client: each stream gets its own STT session. Instead of serverUrl + sessionKey. */
  cloud?: CloudClient;
  /** Cloud mode: how much time each session holds and when it is extended. */
  cloudSession?: CloudSTTSessionOptions;
  /** Server base URL, e.g. "https://stt-xxx.dtel.network" (x402) */
  serverUrl?: string;
  /** JWT session key from x402 gateway */
  sessionKey?: string;
  /**
   * x402 mode: returns a new session key for a reconnect (a key serves one connection). Without
   * it, a lost connection is reported as an error and not retried.
   */
  getSessionKey?: () => Promise<SessionKeyRefresh>;
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
  private webrtcSessionId: string | undefined;

  constructor(options: DtelecomSTTOptions) {
    if (!options.cloud) {
      if (!options.serverUrl) {
        throw new Error('DtelecomSTT requires a serverUrl (or cloud)');
      }
      if (!options.sessionKey) {
        throw new Error('DtelecomSTT requires a sessionKey (or cloud)');
      }
    }
    this.options = options;
  }

  /** Cloud mode: links new STT sessions to the agent's WebRTC session. Called by VoiceAgent. */
  setWebRTCSessionId(sessionId: string): void {
    this.webrtcSessionId = sessionId;
  }

  createStream(options?: STTStreamOptions): STTStream {
    const language = options?.language ?? this.options.language ?? 'auto';
    return new DtelecomSTTStream(this.options, language, this.webrtcSessionId);
  }
}

class DtelecomSTTStream extends BaseSTTStream {
  private ws: WebSocket | null = null;
  private serverUrl: string;
  private sessionKey: string;
  private cloudSession: CloudSpeechSession | null = null;
  private readonly forceWhisper: boolean;
  private readonly partials: boolean | undefined;
  private readonly smartTurn: boolean | undefined;
  private _ready = false;
  /** The connected server advertised finalize in its ready message. */
  private finalizeSupported = false;
  private _closed = false;
  private pendingAudio: Buffer[] = [];
  private pendingBytes = 0;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private language: string;

  constructor(
    private readonly options: DtelecomSTTOptions,
    language: string,
    private readonly webrtcSessionId?: string,
  ) {
    super();
    this.serverUrl = options.serverUrl ?? '';
    this.sessionKey = options.sessionKey ?? '';
    this.language = language;
    this.forceWhisper = options.forceWhisper ?? false;
    this.partials = options.partials;
    this.smartTurn = options.smartTurn;
    if (!options.cloud) {
      this.connect();
      return;
    }
    // Audio sent before the session is ready waits in pendingAudio, as during any connect.
    this.openCloudSession();
  }

  /** Cloud mode: opens a new STT session (in the current language) and connects with its key. */
  private openCloudSession(): void {
    this.cloudSession?.close();
    const session = new CloudSpeechSession({
      kind: 'stt',
      cloud: this.options.cloud!,
      language: this.language,
      stt: this.options.cloudSession,
      onExtended: (sessionKey) => this.sendExtension(sessionKey),
      onError: (error) => this.emit('error', error),
    });
    this.cloudSession = session;
    session.open(this.webrtcSessionId).then(() => {
      if (this._closed || this.cloudSession !== session) {
        session.close();
        return;
      }
      this.serverUrl = session.streamUrl;
      this.sessionKey = session.token;
      this.connect();
    }, (err) => {
      if (this._closed) return;
      log.error('Cloud STT session failed:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    });
  }

  /** After a lost connection: a new session key, then connect; backoff 1 s doubling to 30 s. */
  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_FIRST_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    log.info(`dTelecom STT reconnecting in ${delay}ms...`);
    setTimeout(() => {
      if (!this._closed) this.reconnect();
    }, delay).unref?.();
  }

  private reconnect(): void {
    if (this.options.cloud) {
      this.openCloudSession();
      return;
    }
    const getSessionKey = this.options.getSessionKey;
    if (!getSessionKey) {
      this.emit('error', new Error(
        'dTelecom STT connection lost: a session key serves one connection; pass getSessionKey to reconnect',
      ));
      return;
    }
    getSessionKey().then(({ sessionKey, serverUrl }) => {
      if (this._closed) return;
      this.sessionKey = sessionKey;
      if (serverUrl) this.serverUrl = serverUrl;
      this.connect();
    }, (err) => {
      if (this._closed) return;
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      this.scheduleReconnect();
    });
  }

  /** Hands the extended session key to the open socket; a reconnect uses it from then on. */
  private sendExtension(sessionKey: string): void {
    this.sessionKey = sessionKey;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'extend', session_key: sessionKey }));
    }
  }

  sendAudio(pcm16: Buffer): void {
    if (this._closed) return;

    if (!this._ready) {
      this.pendingAudio.push(pcm16);
      this.pendingBytes += pcm16.length;
      while (this.pendingBytes > MAX_PENDING_BYTES && this.pendingAudio.length > 1) {
        this.pendingBytes -= this.pendingAudio.shift()!.length;
      }
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

  /**
   * Ask the server to end the current utterance now and send its final transcript, instead of
   * waiting for the end-of-speech silence. A no-op (returns false) unless the connected server
   * advertised `finalize: true` in its ready message. The pipeline does not call it yet.
   */
  finalize(): boolean {
    if (this._closed || !this._ready || !this.finalizeSupported || this.ws?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({ type: 'finalize' }));
    return true;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this.finalizeSupported = false;
    this.pendingAudio = [];
    this.pendingBytes = 0;
    this.stopKeepAlive();
    this.cloudSession?.close();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.debug('DtelecomSTT stream closed');
  }

  private connect(): void {
    const wsUrl = toStreamUrl(this.serverUrl);

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
      this.finalizeSupported = false;
      this.stopKeepAlive();

      // Reconnect with a new session key unless closed on purpose: a key serves one connection.
      if (!this._closed) {
        log.info('dTelecom STT connection lost');
        this.scheduleReconnect();
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
    this.finalizeSupported = msg.finalize === true;
    this.reconnectAttempts = 0;
    this.emit('ready', {
      clientId, language: lang,
      ...(msg.smart_turn === 'active' || msg.smart_turn === 'acoustic_fallback'
        ? { smartTurn: msg.smart_turn } : {}),
      ...(this.finalizeSupported ? { finalize: true } : {}),
    });

    // Flush pending audio
    for (const buf of this.pendingAudio) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(buf);
      }
    }
    this.pendingAudio = [];
    this.pendingBytes = 0;

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
