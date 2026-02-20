/**
 * Basic voice agent example.
 *
 * Usage:
 *   DTELECOM_API_KEY=... DTELECOM_API_SECRET=... \
 *   DEEPGRAM_API_KEY=... OPENROUTER_API_KEY=... CARTESIA_API_KEY=... \
 *   npx tsx examples/basic-agent.ts
 */

import { VoiceAgent, setLogLevel } from '@dtelecom/agents';
import { DeepgramSTT, OpenRouterLLM, CartesiaTTS } from '@dtelecom/agents/providers';

setLogLevel('info');

const agent = new VoiceAgent({
  stt: new DeepgramSTT({
    apiKey: process.env.DEEPGRAM_API_KEY!,
    model: 'nova-2',
    language: 'en',
  }),
  llm: new OpenRouterLLM({
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: 'openai/gpt-4o',
    maxTokens: 200,
    temperature: 0.7,
  }),
  tts: new CartesiaTTS({
    apiKey: process.env.CARTESIA_API_KEY!,
    voiceId: 'your-voice-id',
  }),
  instructions: 'You are a helpful voice assistant. Keep responses concise and conversational.',
  respondMode: 'always',
  onDataMessage: (payload, participant, topic) => {
    console.log(`Data from ${participant} [${topic}]:`, new TextDecoder().decode(payload));
  },
});

// Event listeners
agent.on('connected', () => {
  console.log('Agent connected to room');
});

agent.on('transcription', ({ text, isFinal, speaker }) => {
  if (isFinal) {
    console.log(`[${speaker}]: ${text}`);
  }
});

agent.on('response', (text) => {
  console.log(`[Agent]: ${text}`);
});

agent.on('error', (error) => {
  console.error('Agent error:', error);
});

agent.on('disconnected', (reason) => {
  console.log('Agent disconnected:', reason);
});

// Start
await agent.start({
  room: process.env.ROOM_NAME ?? 'agent-test',
  apiKey: process.env.DTELECOM_API_KEY!,
  apiSecret: process.env.DTELECOM_API_SECRET!,
  identity: 'agent',
  name: 'AI Assistant',
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await agent.stop();
  process.exit(0);
});
