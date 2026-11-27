import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';
import { OpenAILLM } from '../src/providers/openai-llm';

afterEach(() => vi.unstubAllGlobals());
function capture() {
  const mock = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', mock);
  return mock;
}
describe('OpenRouter explicit model controls', () => {
  it('omits temperature and retains none/required parameters for plain summary requests', async () => {
    const fetch = capture();
    const llm = new OpenRouterLLM({ apiKey: 'test', model: 'openai/gpt-6-luna', temperature: null, reasoningEffort: 'none', providerRouting: { requireParameters: true }, responseFormat: { type: 'json_schema', json_schema: { name: 'segments', strict: true, schema: {} } } });
    for await (const _ of llm.chat([], undefined, { plainText: true })) { /* consume */ }
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('response_format');
    expect(body.reasoning_effort).toBe('none');
    expect(body.provider.require_parameters).toBe(true);
  });
  it('preserves existing defaults when no model controls are supplied', async () => {
    const fetch = capture();
    for await (const _ of new OpenRouterLLM({ apiKey: 'test', model: 'existing' }).chat([])) { /* consume */ }
    const body = JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.temperature).toBe(0.7);
    expect(body).not.toHaveProperty('reasoning_effort');
  });
});

describe('LLM warmup', () => {
  it.each([
    ['OpenRouterLLM', () => new OpenRouterLLM({ apiKey: 'test', model: 'openai/gpt-6-luna', maxTokens: 512 })],
    ['OpenAILLM', () => new OpenAILLM({ apiKey: 'test', model: 'gpt-4o-mini', maxTokens: 512 })],
  ])('%s primes the connection with the system prompt and a 16-token reply limit; answers keep maxTokens', async (_name, make) => {
    const fetch = capture();
    const llm = make();
    await llm.warmup('You are Peter.');
    for await (const _ of llm.chat([{ role: 'user', content: 'Hi' }])) { /* consume */ }
    const bodies = fetch.mock.calls.map(call => JSON.parse((call as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].max_tokens).toBe(16);
    expect(bodies[0].messages[0]).toEqual({ role: 'system', content: 'You are Peter.' });
    expect(bodies[1].max_tokens).toBe(512);
  });
});
