// Run with the four backend environment variables in the README.
// npx tsx examples/basic-agent.ts
import { CloudClient } from '@dtelecom/server-sdk-js';
import { VoiceAgent } from '@dtelecom/agents-js';
import { DtelecomSTT, DtelecomTTS, OpenRouterLLM } from '@dtelecom/agents-js/providers';

async function main() {
  const cloud = new CloudClient();
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('Set OPENROUTER_API_KEY for the language model');

  const agent = new VoiceAgent({
    stt: new DtelecomSTT({ cloud, language: 'en', partials: true, smartTurn: true }),
    llm: new OpenRouterLLM({ apiKey, model: 'openai/gpt-4o-mini', maxTokens: 120 }),
    tts: new DtelecomTTS({ cloud, voices: { en: { voice: 'af_heart', langCode: 'a' } } }),
    instructions: 'Answer in one or two short sentences.',
    respondMode: 'always',
  });
  agent.on('transcription', ({ text, isFinal }) => {
    if (isFinal) console.log('Heard:', text);
  });
  agent.on('response', (text) => console.log('Assistant:', text));
  agent.on('error', (error) => console.error('Agent error:', error.message));

  const room = process.env.ROOM_NAME || 'voice-demo';
  await agent.start({ room, identity: 'assistant', cloud, ttl: '10m' });
  console.log(`Listening in ${room}. Press Ctrl+C to disconnect.`);
  process.once('SIGINT', async () => {
    await agent.stop();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
