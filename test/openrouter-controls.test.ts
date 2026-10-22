import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';

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
