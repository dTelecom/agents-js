/**
 * OpenAILLM — streaming LLM via OpenAI API.
 *
 * Uses native fetch() with SSE parsing for streaming responses.
 * No SDK dependency — just HTTP.
 */

import type { LLMPlugin, LLMChunk, LLMChatOptions, Message } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('OpenAILLM');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

export interface OpenAILLMOptions {
  apiKey: string;
  /** Model identifier (e.g. 'gpt-4o', 'gpt-4o-mini') */
  model: string;
  /** Max tokens in response (default: 512) */
  maxTokens?: number;
  /** Sampling temperature 0-2 (default: 0.7) */
  temperature?: number;
  /** Structured output via constrained decoding (e.g. for multi-language segment routing) */
  responseFormat?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

export class OpenAILLM implements LLMPlugin {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly responseFormat?: OpenAILLMOptions['responseFormat'];

  constructor(options: OpenAILLMOptions) {
    if (!options.apiKey) {
      throw new Error('OpenAILLM requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 512;
    this.temperature = options.temperature ?? 0.7;
    this.responseFormat = options.responseFormat;
  }

  /**
   * Warm up the LLM by sending the system prompt and a short message.
   * Primes the HTTP/TLS connection and model loading on the provider side.
   */
  async warmup(systemPrompt: string): Promise<void> {
    log.info('Warming up LLM connection...');
    const start = performance.now();

    const messages: Message[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Hello' },
    ];

    try {
      const gen = this.chat(messages);
      for await (const chunk of gen) {
        if (chunk.type === 'done') break;
      }
      log.info(`LLM warmup complete in ${(performance.now() - start).toFixed(0)}ms`);
    } catch (err) {
      log.warn('LLM warmup failed (non-fatal):', err);
    }
  }

  async *chat(messages: Message[], signal?: AbortSignal, options?: LLMChatOptions): AsyncGenerator<LLMChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (this.responseFormat && !options?.plainText) {
      body.response_format = this.responseFormat;
    }

    log.debug(`LLM request: model=${this.model}, messages=${messages.length}`);

    const response = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('OpenAI response has no body');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Structured output: stream segment objects as they complete in the JSON buffer.
    const structured = !!this.responseFormat && !options?.plainText;
    let jsonBuffer = '';
    let segmentsYielded = false;
    let lastUsage: { promptTokens: number; completionTokens: number } | undefined;

    // Streaming segment extraction state
    let inSegmentsArray = false;
    let objectStart = -1;
    let braceDepth = 0;
    let scanIndex = 0;
    let inString = false;
    let escaped = false;

    function extractSegments(buf: string): Array<{ lang: string; text: string }> {
      const results: Array<{ lang: string; text: string }> = [];

      for (let i = scanIndex; i < buf.length; i++) {
        const ch = buf[i];

        if (escaped) {
          escaped = false;
          continue;
        }

        if (ch === '\\' && inString) {
          escaped = true;
          continue;
        }

        if (ch === '"') {
          inString = !inString;
          continue;
        }

        if (inString) continue;

        if (!inSegmentsArray) {
          if (ch === '[') {
            const before = buf.slice(0, i).trimEnd();
            if (before.endsWith(':') && buf.slice(0, i).includes('"segments"')) {
              inSegmentsArray = true;
            }
          }
          continue;
        }

        if (ch === '{') {
          if (braceDepth === 0) objectStart = i;
          braceDepth++;
        } else if (ch === '}') {
          braceDepth--;
          if (braceDepth === 0 && objectStart >= 0) {
            const objStr = buf.slice(objectStart, i + 1);
            try {
              const seg = JSON.parse(objStr);
              if (seg.lang && seg.text) {
                results.push({ lang: seg.lang, text: seg.text });
              }
            } catch {
              // Incomplete or malformed — skip
            }
            objectStart = -1;
          }
        } else if (ch === ']' && braceDepth === 0) {
          inSegmentsArray = false;
        }
      }

      scanIndex = buf.length;
      return results;
    }

    try {
      while (true) {
        if (signal?.aborted) break;

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          const data = trimmed.slice(6);
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) {
              // Final chunk may have usage without choices
              if (parsed.usage) {
                lastUsage = {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                };
              }
              continue;
            }

            const delta = choice.delta;
            if (delta?.content) {
              if (structured) {
                jsonBuffer += delta.content;

                const segments = extractSegments(jsonBuffer);
                for (const seg of segments) {
                  yield { type: 'segment', segment: seg };
                  segmentsYielded = true;
                }
              } else {
                yield { type: 'token', token: delta.content };
              }
            }

            if (parsed.usage) {
              lastUsage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
              };
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (structured && !segmentsYielded && jsonBuffer.length > 0) {
      log.warn(`LLM returned no segments. Raw JSON: "${jsonBuffer.slice(0, 300)}"`);
    }

    yield { type: 'done', ...(lastUsage ? { usage: lastUsage } : {}) };
  }
}
