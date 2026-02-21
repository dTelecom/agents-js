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
  /** OpenRouter API key for LLM-based language tagging (multi-language only) */
  openRouterApiKey?: string;
  /** Fast model for tagging (default: 'openai/gpt-4o-mini') */
  tagModel?: string;
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

export class DeepgramTTS implements TTSPlugin {
  private readonly apiKey: string;
  private readonly models: Record<string, string>;
  private readonly defaultLang: string;
  private readonly sampleRate: number;
  private readonly multiLanguage: boolean;
  private readonly openRouterApiKey?: string;
  private readonly tagModel: string;
  private readonly tagSystemPrompt: string;

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
    this.openRouterApiKey = options.openRouterApiKey;
    this.tagModel = options.tagModel ?? 'openai/gpt-4o-mini';

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

    // Build system prompt for language tagging from configured languages
    const nonDefaultLangs = Object.keys(this.models).filter((l) => l !== this.defaultLang);
    this.tagSystemPrompt = `You add SSML language tags to mixed-language text.
Available languages: ${this.defaultLang} (default), ${nonDefaultLangs.join(', ')}.
Wrap every non-${this.defaultLang} word/phrase in <lang xml:lang="CODE">...</lang>.
${this.defaultLang.charAt(0).toUpperCase() + this.defaultLang.slice(1)} text gets no tag. Return ONLY the tagged text, nothing else.`;
  }

  /** Pre-connect all language connections + warm up tagging LLM in parallel. */
  async warmup(): Promise<void> {
    log.info('Warming up TTS connections...');
    const start = performance.now();
    try {
      const tasks: Promise<void>[] = Object.keys(this.models).map((lang) => this.ensureConnection(lang));
      if (this.openRouterApiKey && this.multiLanguage) {
        tasks.push(this.warmupTagging());
      }
      await Promise.all(tasks);
      log.info(`TTS warmup complete in ${(performance.now() - start).toFixed(0)}ms`);
    } catch (err) {
      log.warn('TTS warmup failed (non-fatal):', err);
    }
  }

  /** Prime the tagging LLM with a short request to warm up the connection. */
  private async warmupTagging(): Promise<void> {
    try {
      const start = performance.now();
      await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openRouterApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.tagModel,
          messages: [
            { role: 'system', content: this.tagSystemPrompt },
            { role: 'user', content: 'Hello' },
          ],
          max_tokens: 10,
        }),
      });
      log.info(`Tagging LLM warmup complete in ${(performance.now() - start).toFixed(0)}ms`);
    } catch (err) {
      log.warn('Tagging LLM warmup failed (non-fatal):', err);
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

  /** Add SSML language tags via a fast LLM (multi-language only). */
  async preprocessText(text: string, signal?: AbortSignal): Promise<string> {
    if (!this.openRouterApiKey || !this.multiLanguage) return text;
    if (signal?.aborted) return text;

    try {
      const start = performance.now();
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openRouterApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.tagModel,
          messages: [
            { role: 'system', content: this.tagSystemPrompt },
            { role: 'user', content: text },
          ],
          max_tokens: Math.max(256, text.length * 2),
        }),
        signal,
      });

      if (!res.ok) {
        log.warn(`Tagging LLM returned ${res.status} — using untagged text`);
        return text;
      }

      const json = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const tagged = json.choices?.[0]?.message?.content?.trim();

      if (!tagged) {
        log.warn('Tagging LLM returned empty response — using untagged text');
        return text;
      }

      log.debug(`Tagged in ${(performance.now() - start).toFixed(0)}ms: "${tagged.slice(0, 80)}"`);
      return tagged;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return text;
      log.warn('Tagging LLM failed — using untagged text:', err);
      return text;
    }
  }

  async *synthesize(text: string, signal?: AbortSignal): AsyncGenerator<Buffer> {
    if (signal?.aborted) return;

    const segments = this.multiLanguage
      ? parseLangSegments(text, this.defaultLang)
      : [{ lang: this.defaultLang, text }];

    for (const segment of segments) {
      if (signal?.aborted) break;
      if (!segment.text.trim()) continue;
      const lang = this.models[segment.lang] ? segment.lang : this.defaultLang;
      yield* this.synthesizeSegment(lang, segment.text, signal);
    }
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
