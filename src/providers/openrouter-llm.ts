/**
 * OpenRouterLLM — streaming LLM via OpenRouter (OpenAI-compatible API).
 *
 * Uses native fetch() with SSE parsing for streaming responses.
 * No SDK dependency — just HTTP.
 */

import type { LLMPlugin, LLMChunk, Message } from '../core/types';
import { createLogger } from '../utils/logger';

const log = createLogger('OpenRouterLLM');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface OpenRouterLLMOptions {
  apiKey: string;
  /** Model identifier (e.g. 'openai/gpt-4o', 'anthropic/claude-sonnet-4') */
  model: string;
  /** Max tokens in response (default: 512) */
  maxTokens?: number;
  /** Sampling temperature 0-2 (default: 0.7) */
  temperature?: number;
  /** OpenRouter provider routing preferences */
  providerRouting?: {
    /** Sort providers by metric (e.g. 'latency') */
    sort?: string;
    /** Pin to specific providers in order */
    order?: string[];
    /** Allow fallback to other providers if pinned ones fail */
    allowFallbacks?: boolean;
  };
  /** Structured output via constrained decoding (e.g. for multi-language segment routing) */
  responseFormat?: {
    type: 'json_schema';
    json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
  };
}

export class OpenRouterLLM implements LLMPlugin {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly provider?: { sort?: string; order?: string[]; allow_fallbacks?: boolean };
  private readonly responseFormat?: OpenRouterLLMOptions['responseFormat'];

  constructor(options: OpenRouterLLMOptions) {
    if (!options.apiKey) {
      throw new Error('OpenRouterLLM requires an apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 512;
    this.temperature = options.temperature ?? 0.7;

    if (options.providerRouting) {
      this.provider = {
        sort: options.providerRouting.sort,
        order: options.providerRouting.order,
        allow_fallbacks: options.providerRouting.allowFallbacks,
      };
    }

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

  async *chat(messages: Message[], signal?: AbortSignal): AsyncGenerator<LLMChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    };
    if (this.provider) {
      body.provider = { ...this.provider };
    }
    if (this.responseFormat) {
      body.response_format = this.responseFormat;
      // Ensure the provider enforces structured output parameters
      const prov = (body.provider ?? {}) as Record<string, unknown>;
      prov.require_parameters = true;
      body.provider = prov;
    }

    log.debug(`LLM request: model=${this.model}, messages=${messages.length}`);

    const response = await fetch(OPENROUTER_URL, {
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
      throw new Error(`OpenRouter API error ${response.status}: ${errorText}`);
    }

    if (!response.body) {
      throw new Error('OpenRouter response has no body');
    }

    // Parse SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Structured output: accumulate JSON tokens to detect completed segments
    const structured = !!this.responseFormat;
    let jsonBuffer = '';
    let lastSegmentIndex = 0;
    const segmentRe = /\{"lang"\s*:\s*"(\w+)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;

    try {
      while (true) {
        // Check abort before blocking on read — prevents hanging when signal
        // was fired while we were yielding tokens to the pipeline
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
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta;
            if (delta?.content) {
              if (structured) {
                // Structured mode: only yield segment chunks, not raw JSON tokens
                jsonBuffer += delta.content;
                segmentRe.lastIndex = lastSegmentIndex;
                let match: RegExpExecArray | null;
                while ((match = segmentRe.exec(jsonBuffer)) !== null) {
                  const lang = match[1];
                  // Unescape JSON string escapes (e.g. \" → ", \n → newline)
                  const text = match[2].replace(/\\(.)/g, (_, c) => {
                    if (c === 'n') return '\n';
                    if (c === 't') return '\t';
                    return c;
                  });
                  lastSegmentIndex = segmentRe.lastIndex;
                  yield { type: 'segment', segment: { lang, text } };
                }
              } else {
                yield { type: 'token', token: delta.content };
              }
            }

            // Usage stats in the final chunk
            if (parsed.usage) {
              yield {
                type: 'done',
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens,
                },
              };
              return;
            }
          } catch {
            // Skip malformed JSON chunks
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (structured && lastSegmentIndex === 0 && jsonBuffer.length > 0) {
      log.warn(`Structured response yielded no segments. Raw buffer (first 200 chars): "${jsonBuffer.slice(0, 200)}"`);
    }

    yield { type: 'done' };
  }
}
