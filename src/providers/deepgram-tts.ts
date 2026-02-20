/**
 * DeepgramTTS — real-time streaming TTS via Deepgram Aura-2 WebSocket API.
 *
 * Protocol:
 * - Connect to wss://api.deepgram.com/v1/speak?model={model}&encoding=linear16&sample_rate={rate}
 * - Auth: Authorization: Token <key> header
 * - Send: {"type":"Speak","text":"..."} then {"type":"Flush"}
 * - Receive: binary frames (raw PCM16) until {"type":"Flushed"} JSON
 * - Cancel: {"type":"Clear"} then {"type":"Flush"}, wait for Flushed
 *
 * Supports multi-language via connection pool (one WS per language).
 * Uses SSML <lang> tags to route text segments to the correct voice.
 */

import WebSocket from 'ws';
import type { TTSPlugin } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('DeepgramTTS');

const DEEPGRAM_WS_BASE = 'wss://api.deepgram.com/v1/speak';
const DEFAULT_SAMPLE_RATE = 48000;

export interface DeepgramTTSOptions {
  apiKey: string;
  /** Single model string OR language->model map for multi-language */
  model: string | Record<string, string>;
  /** Default language for untagged text (default: 'en' or first key) */
  defaultLanguage?: string;
  /** Sample rate (default: 48000 — matches pipeline) */
  sampleRate?: number;
}

interface LangSegment {
  lang: string;
  text: string;
}

/** Per-connection state for tracking an in-flight synthesis. */
interface FlushState {
  chunks: Buffer[];
  flushed: boolean;
  error: Error | null;
  wake: (() => void) | null;
}

/**
 * Parse SSML <lang> tags into segments.
 *
 * Input:  `Great job! <lang xml:lang="es">Ahora repite: buenos días.</lang>`
 * Output: [{lang:'en', text:'Great job!'}, {lang:'es', text:'Ahora repite: buenos días.'}]
 *
 * Text outside tags uses defaultLang. Handles no tags, adjacent tags, nested text.
 * Malformed input is treated as default language.
 */
export function parseLangSegments(text: string, defaultLang: string): LangSegment[] {
  const segments: LangSegment[] = [];
  let i = 0;
  let currentText = '';

  while (i < text.length) {
    // Look for opening <lang tag
    if (text[i] === '<' && text.startsWith('<lang ', i)) {
      // Flush accumulated default-language text
      if (currentText) {
        segments.push({ lang: defaultLang, text: currentText.trim() });
        currentText = '';
      }

      // Find xml:lang="..."
      const xmlLangStart = text.indexOf('xml:lang="', i);
      if (xmlLangStart === -1) {
        // Malformed — treat rest as default
        currentText += text[i];
        i++;
        continue;
      }

      const langStart = xmlLangStart + 'xml:lang="'.length;
      const langEnd = text.indexOf('"', langStart);
      if (langEnd === -1) {
        currentText += text[i];
        i++;
        continue;
      }

      const lang = text.substring(langStart, langEnd);

      // Find end of opening tag ">"
      const tagClose = text.indexOf('>', langEnd);
      if (tagClose === -1) {
        currentText += text[i];
        i++;
        continue;
      }

      // Find closing </lang>
      const closingTag = '</lang>';
      const closingStart = text.indexOf(closingTag, tagClose + 1);
      if (closingStart === -1) {
        // No closing tag — treat the rest after opening tag as this language
        const innerText = text.substring(tagClose + 1).trim();
        if (innerText) {
          segments.push({ lang, text: innerText });
        }
        i = text.length;
        continue;
      }

      const innerText = text.substring(tagClose + 1, closingStart).trim();
      if (innerText) {
        segments.push({ lang, text: innerText });
      }

      i = closingStart + closingTag.length;
      continue;
    }

    currentText += text[i];
    i++;
  }

  // Flush remaining default-language text
  if (currentText.trim()) {
    segments.push({ lang: defaultLang, text: currentText.trim() });
  }

  return segments;
}

/**
 * Character patterns that indicate a specific language.
 * Used as fallback detection for untagged text in multi-language mode.
 */
const LANG_DETECT_PATTERNS: Record<string, RegExp> = {
  // Spanish: inverted punctuation, ñ, accented vowels
  es: /[¡¿ñáéíóúüÁÉÍÓÚÜÑ]/,
  // Japanese: hiragana, katakana, CJK ideographs, fullwidth forms
  ja: /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\uff00-\uffef]/,
  // Korean: Hangul
  ko: /[\uac00-\ud7af\u1100-\u11ff]/,
  // Chinese: CJK ideographs (overlaps with ja, but useful when ja not configured)
  zh: /[\u4e00-\u9fff\u3400-\u4dbf]/,
};

/** Split text into sentences on sentence-ending punctuation. */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?¡¿。！？])\s+/).filter((s) => s.trim());
}

export class DeepgramTTS implements TTSPlugin {
  private readonly apiKey: string;
  private readonly models: Record<string, string>;
  private readonly defaultLang: string;
  private readonly sampleRate: number;
  private readonly multiLanguage: boolean;

  /** Connection pool: one WebSocket per language code */
  private connections = new Map<string, WebSocket>();
  private connectPromises = new Map<string, Promise<void>>();
  /** Per-connection flush state */
  private flushStates = new Map<string, FlushState>();

  constructor(options: DeepgramTTSOptions) {
    if (!options.apiKey) {
      throw new Error('DeepgramTTS requires an apiKey');
    }

    this.apiKey = options.apiKey;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;

    if (typeof options.model === 'string') {
      // Single-language mode
      this.multiLanguage = false;
      const lang = options.defaultLanguage ?? 'en';
      this.models = { [lang]: options.model };
      this.defaultLang = lang;
    } else {
      // Multi-language mode
      this.multiLanguage = true;
      this.models = { ...options.model };
      const keys = Object.keys(this.models);
      if (keys.length === 0) {
        throw new Error('DeepgramTTS model map must have at least one entry');
      }
      this.defaultLang = options.defaultLanguage ?? keys[0];
    }
  }

  /** Pre-connect all language connections in parallel. */
  async warmup(): Promise<void> {
    log.info('Warming up TTS connections...');
    const start = performance.now();
    try {
      const langs = Object.keys(this.models);
      await Promise.all(langs.map((lang) => this.ensureConnection(lang)));
      log.info(`TTS warmup complete in ${(performance.now() - start).toFixed(0)}ms (${langs.length} connection(s))`);
    } catch (err) {
      log.warn('TTS warmup failed (non-fatal):', err);
    }
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

    let segments = this.multiLanguage
      ? parseLangSegments(text, this.defaultLang)
      : [{ lang: this.defaultLang, text }];

    // Auto-detect language for untagged default-language segments
    if (this.multiLanguage) {
      segments = this.autoDetectSegments(segments);
    }

    for (const segment of segments) {
      if (signal?.aborted) break;
      if (!segment.text.trim()) continue;

      const lang = this.models[segment.lang] ? segment.lang : this.defaultLang;
      yield* this.synthesizeSegment(lang, segment.text, signal);
    }
  }

  /**
   * Split untagged default-language segments into sentences and detect
   * the language of each sentence using character markers.
   * Merges consecutive same-language sentences back together.
   */
  private autoDetectSegments(segments: LangSegment[]): LangSegment[] {
    const result: LangSegment[] = [];

    for (const seg of segments) {
      // Only process untagged (default language) segments
      if (seg.lang !== this.defaultLang) {
        result.push(seg);
        continue;
      }

      // Split into sentences and detect language per sentence
      const sentences = splitSentences(seg.text);
      if (sentences.length <= 1) {
        const detected = this.detectLang(seg.text);
        if (detected !== this.defaultLang) {
          log.debug(`Auto-detected [${detected}] for: "${seg.text.slice(0, 40)}"`);
        }
        result.push({ lang: detected, text: seg.text });
        continue;
      }

      // Detect per sentence and merge consecutive same-language runs
      let current: LangSegment | null = null;
      for (const sentence of sentences) {
        const lang = this.detectLang(sentence);
        if (lang !== this.defaultLang) {
          log.debug(`Auto-detected [${lang}] for: "${sentence.slice(0, 40)}"`);
        }
        if (current && current.lang === lang) {
          current.text += ' ' + sentence;
        } else {
          if (current) result.push(current);
          current = { lang, text: sentence };
        }
      }
      if (current) result.push(current);
    }

    return result;
  }

  /** Detect language of text using character markers. Returns default if no markers found. */
  private detectLang(text: string): string {
    for (const lang of Object.keys(this.models)) {
      if (lang === this.defaultLang) continue;
      const pattern = LANG_DETECT_PATTERNS[lang];
      if (pattern && pattern.test(text)) return lang;
    }
    return this.defaultLang;
  }

  private async *synthesizeSegment(
    lang: string,
    text: string,
    signal?: AbortSignal,
  ): AsyncGenerator<Buffer> {
    log.debug(`Synthesizing [${lang}]: "${text.slice(0, 60)}"`);

    await this.ensureConnection(lang);

    const ws = this.connections.get(lang);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Deepgram WebSocket not connected for language "${lang}"`);
    }

    const state: FlushState = { chunks: [], flushed: false, error: null, wake: null };
    this.flushStates.set(lang, state);

    // Handle abort — send Clear + Flush to cancel
    const onAbort = () => {
      state.flushed = true;
      state.wake?.();
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'Clear' }));
          ws.send(JSON.stringify({ type: 'Flush' }));
        } catch {
          // Ignore send errors during cancellation
        }
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    // Send Speak + Flush
    ws.send(JSON.stringify({ type: 'Speak', text }));
    ws.send(JSON.stringify({ type: 'Flush' }));

    try {
      while (true) {
        if (signal?.aborted) break;
        if (state.error) throw state.error;

        if (state.chunks.length > 0) {
          yield state.chunks.shift()!;
          continue;
        }

        if (state.flushed) break;

        // Wait for next chunk or Flushed signal
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
      this.flushStates.delete(lang);
    }
  }

  /** Ensure a WebSocket connection exists for the given language. */
  private ensureConnection(lang: string): Promise<void> {
    const existing = this.connections.get(lang);
    if (existing && existing.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    // Deduplicate concurrent connection attempts
    const pending = this.connectPromises.get(lang);
    if (pending) return pending;

    const model = this.models[lang];
    if (!model) {
      return Promise.reject(new Error(`No Deepgram model configured for language "${lang}"`));
    }

    const promise = new Promise<void>((resolve, reject) => {
      const url = `${DEEPGRAM_WS_BASE}?model=${encodeURIComponent(model)}&encoding=linear16&sample_rate=${this.sampleRate}`;
      log.debug(`Connecting to Deepgram for [${lang}]: ${model}`);

      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${this.apiKey}`,
        },
      });

      ws.on('open', () => {
        this.connections.set(lang, ws);
        this.connectPromises.delete(lang);
        log.info(`Deepgram WebSocket connected for [${lang}] (${model})`);
        resolve();
      });

      ws.on('message', (data, isBinary) => {
        const state = this.flushStates.get(lang);
        if (!state) return;

        if (isBinary) {
          // Binary frame = raw PCM16 audio
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          state.chunks.push(buf);
          state.wake?.();
        } else {
          // Text frame = JSON control message
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'Flushed') {
              state.flushed = true;
              state.wake?.();
            } else if (msg.type === 'Warning' || msg.type === 'Error') {
              log.warn(`Deepgram [${lang}] ${msg.type}: ${msg.description || msg.message || JSON.stringify(msg)}`);
            }
          } catch {
            log.warn(`Failed to parse Deepgram message for [${lang}]`);
          }
        }
      });

      ws.on('error', (err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(`Deepgram WebSocket error [${lang}]:`, error);
        const state = this.flushStates.get(lang);
        if (state) {
          state.error = error;
          state.wake?.();
        }
        this.connections.delete(lang);
        this.connectPromises.delete(lang);
        reject(error);
      });

      ws.on('close', (code, reason) => {
        log.debug(`Deepgram WebSocket closed [${lang}]: ${code} ${reason.toString()}`);
        this.connections.delete(lang);
        this.connectPromises.delete(lang);
        const state = this.flushStates.get(lang);
        if (state) {
          state.flushed = true;
          state.wake?.();
        }
      });
    });

    this.connectPromises.set(lang, promise);
    return promise;
  }
}
