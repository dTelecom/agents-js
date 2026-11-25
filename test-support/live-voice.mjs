import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CloudClient } from '@dtelecom/server-sdk-js';
import { setLogLevel as setRtcLogLevel, LogLevel } from '@dtelecom/server-sdk-node';
import { VoiceAgent, setLogLevel } from '@dtelecom/agents-js';
import { DtelecomSTT, DtelecomTTS, OpenRouterLLM } from '@dtelecom/agents-js/providers';
import { browserCall } from './browser-call.mjs';

setLogLevel('silent');
setRtcLogLevel(LogLevel.SILENT);
const cloud = new CloudClient();
const room = 'sdk-voice-' + randomUUID();
const speechWav = await readFile(new URL('./question.wav', import.meta.url));
const agent = new VoiceAgent({
  stt: new DtelecomSTT({ cloud, language: 'en', smartTurn: true }),
  llm: new OpenRouterLLM({ apiKey: process.env.OPENROUTER_API_KEY, model: 'openai/gpt-4o-mini', maxTokens: 40 }),
  tts: new DtelecomTTS({ cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } } }),
  instructions: 'Answer the question in one short English sentence.',
  respondMode: 'always',
});
let ready = false, transcript = '', reply = '';
agent.on('stt_ready', () => { ready = true; });
agent.on('transcription', result => { if (result.isFinal) transcript = result.text; });
agent.on('response', text => { reply = text; });
agent.on('error', () => console.error('The voice agent reported a provider or room error.'));
try {
  await agent.start({ cloud, room, identity: 'assistant', ttl: '3m' });
  await browserCall({ cloud, room, peer: 'assistant', speechWav, inputReady: () => ready, replyComplete: () => Boolean(reply) });
  assert.match(transcript, /sky/i, 'The final transcript should mention the sky');
  assert.match(reply, /\bblue\b/i, 'The model should answer the spoken question about the daytime sky');
  console.log('Recognized the sky question and played the model’s answer about blue in Chromium.');
} finally {
  await agent.stop();
}
