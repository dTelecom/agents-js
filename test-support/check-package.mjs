import assert from 'node:assert/strict';
import { CloudClient } from '@dtelecom/server-sdk-js';
import { VoiceAgent } from '@dtelecom/agents-js';
import { DtelecomSTT, DtelecomTTS, OpenRouterLLM } from '@dtelecom/agents-js/providers';

// Construction checks the published provider exports and RTC peer dependency without a network call.
const cloud = new CloudClient({ baseUrl: 'https://example.invalid', apiKey: 'fixture', apiSecret: 'fixture' });
const agent = new VoiceAgent({
  stt: new DtelecomSTT({ cloud }),
  llm: new OpenRouterLLM({ apiKey: 'fixture', model: 'openai/gpt-4o-mini' }),
  tts: new DtelecomTTS({ cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } } }),
});
assert.equal(agent.running, false);
