/**
 * DeepgramSTT — real-time streaming STT via Deepgram WebSocket API.
 *
 * Protocol:
 * - Connect to wss://api.deepgram.com/v1/listen?... with config as query params
 * - Auth via Authorization header: "Token <apiKey>"
 * - Send audio as binary WebSocket frames (PCM16 16kHz mono)
 * - Receive JSON: { type: "Results", channel: { alternatives: [{ transcript }] }, is_final, speech_final }
 * - Send KeepAlive every 5s when no audio is being sent
 * - Send CloseStream to gracefully shut down
 *
 * End-of-utterance strategy:
 *   Buffer all is_final=true transcripts. Emit the buffered utterance as a
 *   single final TranscriptionResult when speech_final=true OR UtteranceEnd
 *   arrives. Interim results (is_final=false) are emitted immediately for
 *   real-time feedback.
 */

import WebSocket from 'ws';
import { BaseSTTStream } from '../core/base-stt-stream';
import type { STTPlugin, STTStream, STTStreamOptions, TranscriptionResult } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DeepgramSTT');

const DEEPGRAM_WS_URL = 'wss://api.deepgram.com/v1/listen';
const KEEPALIVE_INTERVAL_MS = 5_000;

export interface DeepgramSTTOptions {
  apiKey: string;
  /** Deepgram model (default: 'nova-3') */
  model?: string;
  /** Language code (default: 'en') */
  language?: string;
  /** Enable interim results (default: true) */
  interimResults?: boolean;
  /** Enable punctuation (default: true) */
  punctuate?: boolean;
  /** Endpointing in ms (default: 300). Set to false to disable. */
  endpointing?: number | false;
  /** Keywords to boost recognition (e.g. ['dTelecom:5', 'WebRTC:3']) */
  keywords?: string[];
  /** Enable smart formatting (default: false) */
  smartFormat?: boolean;
  /** Utterance end timeout in ms (default: 1000). Requires interimResults. */
  utteranceEndMs?: number;
}

export class DeepgramSTT implements STTPlugin {
  private readonly options: Required<Pick<DeepgramSTTOptions, 'apiKey'>> & DeepgramSTTOptions;

  constructor(options: DeepgramSTTOptions) {
    if (!options.apiKey) {
      throw new Error('DeepgramSTT requires an apiKey');
    }
    this.options = options;
  }

  createStream(options?: STTStreamOptions): STTStream {
    const language = options?.language ?? this.options.language ?? 'en';
    return new DeepgramSTTStream(this.options, language);
  }
}

class DeepgramSTTStream extends BaseSTTStream {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private _ready = false;
  private _closed = false;
  private pendingAudio: Buffer[] = [];
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioSentAt = 0;
  /** Buffer of is_final=true transcripts for the current utterance */
  private utteranceBuffer: string[] = [];
  /** Timestamp of the last non-empty interim result (approximates end of speech) */
  private lastInterimAt = 0;

  constructor(options: DeepgramSTTOptions, language: string) {
    super();
    this.apiKey = options.apiKey;
    this.wsUrl = buildWsUrl(options, language);
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
      this.lastAudioSentAt = performance.now();
    }
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._ready = false;
    this.pendingAudio = [];
    this.stopKeepAlive();

    if (this.ws?.readyState === WebSocket.OPEN) {
      // Graceful shutdown — ask server to flush remaining audio
      try {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      } catch {
        // Ignore send errors during shutdown
      }
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    log.debug('DeepgramSTT stream closed');
  }

  private connect(): void {
    log.debug(`Connecting to Deepgram: ${this.wsUrl.replace(/token=[^&]+/, 'token=***')}`);

    this.ws = new WebSocket(this.wsUrl, {
      headers: {
        Authorization: `Token ${this.apiKey}`,
      },
    });

    this.ws.on('open', () => {
      log.info('Deepgram WebSocket connected');
      this._ready = true;

      // Flush pending audio
      for (const buf of this.pendingAudio) {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(buf);
        }
      }
      this.pendingAudio = [];

      this.startKeepAlive();
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (err) {
        log.error('Failed to parse Deepgram message:', err);
      }
    });

    this.ws.on('error', (err) => {
      log.error('Deepgram WebSocket error:', err);
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
    });

    this.ws.on('close', (code, reason) => {
      log.debug(`Deepgram WebSocket closed: ${code} ${reason.toString()}`);
      this._ready = false;
      this.stopKeepAlive();

      // Reconnect if not intentionally closed
      if (!this._closed) {
        log.info('Deepgram connection lost, reconnecting in 1s...');
        setTimeout(() => {
          if (!this._closed) this.connect();
        }, 1000);
      }
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === 'Results') {
      this.handleResults(msg);
    } else if (type === 'UtteranceEnd') {
      this.flushUtterance();
    } else if (type === 'Metadata') {
      log.debug('Deepgram session metadata received');
    } else if (type === 'SpeechStarted') {
      log.debug('Speech started detected');
    }
  }

  private handleResults(msg: Record<string, unknown>): void {
    const channel = msg.channel as { alternatives?: Array<{ transcript?: string; confidence?: number }> } | undefined;
    const transcript = channel?.alternatives?.[0]?.transcript ?? '';
    const confidence = channel?.alternatives?.[0]?.confidence;
    const isFinal = msg.is_final as boolean ?? false;
    const speechFinal = msg.speech_final as boolean ?? false;

    if (!transcript) return;

    if (!isFinal) {
      // Interim result — emit immediately for real-time feedback.
      // Include any buffered finals as prefix so the UI shows the full utterance.
      this.lastInterimAt = performance.now();
      const fullInterim = this.utteranceBuffer.length > 0
        ? this.utteranceBuffer.join(' ') + ' ' + transcript
        : transcript;
      this.emit('transcription', {
        text: fullInterim,
        isFinal: false,
        confidence: confidence ?? undefined,
      } satisfies TranscriptionResult);
      return;
    }

    // is_final=true — buffer this segment
    this.utteranceBuffer.push(transcript);

    if (speechFinal) {
      // End of utterance — emit the complete buffered transcript
      this.flushUtterance();
    }
  }

  /** Emit the buffered utterance as a single final transcription result. */
  private flushUtterance(): void {
    if (this.utteranceBuffer.length === 0) return;

    const now = performance.now();
    const fullText = this.utteranceBuffer.join(' ');
    this.utteranceBuffer = [];

    // sttDuration = time from last interim (≈ end of speech) to now (final result)
    // This includes endpointing delay + STT processing + network
    const sttDuration = this.lastInterimAt > 0 ? now - this.lastInterimAt : undefined;

    if (sttDuration !== undefined) {
      log.info(`stt_final: ${sttDuration.toFixed(0)}ms "${fullText.slice(0, 50)}"`);
    }

    this.lastInterimAt = 0;

    this.emit('transcription', {
      text: fullText,
      isFinal: true,
      sttDuration,
    } satisfies TranscriptionResult);
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
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

/** Build the Deepgram WebSocket URL with query parameters. */
function buildWsUrl(options: DeepgramSTTOptions, language: string): string {
  const params = new URLSearchParams();

  params.set('model', options.model ?? 'nova-3');
  params.set('language', language);
  params.set('encoding', 'linear16');
  params.set('sample_rate', '16000');
  params.set('channels', '1');
  params.set('interim_results', String(options.interimResults ?? true));
  params.set('punctuate', String(options.punctuate ?? true));

  if (options.endpointing === false) {
    params.set('endpointing', 'false');
  } else {
    params.set('endpointing', String(options.endpointing ?? 300));
  }

  if (options.smartFormat) {
    params.set('smart_format', 'true');
  }

  if (options.utteranceEndMs !== undefined) {
    params.set('utterance_end_ms', String(options.utteranceEndMs));
  } else if (options.interimResults !== false) {
    // Default utterance_end_ms when interim results are enabled
    params.set('utterance_end_ms', '1000');
  }

  if (options.keywords?.length) {
    for (const kw of options.keywords) {
      params.append('keywords', kw);
    }
  }

  return `${DEEPGRAM_WS_URL}?${params.toString()}`;
}
