/**
 * End-to-end voice agent test (manual — requires a human in the room).
 *
 * Connects to a dTelecom room with real providers (Deepgram STT, OpenRouter LLM,
 * Cartesia TTS). A human must join the same room and speak to test the full loop.
 *
 * Logs all events and measures latency breakdown:
 *   STT → LLM first token → first sentence → TTS first audio → total
 *
 * Requires a .env file in the project root (see .env.example).
 *
 * Optional env vars:
 *   ROOM_NAME (default: "e2e-test")
 *   LLM_MODEL (default: "openai/gpt-4o")
 *
 * Usage:
 *   npx tsx examples/e2e-test.ts
 */

import 'dotenv/config';
import { VoiceAgent, setLogLevel } from '../src/index';
import { DeepgramSTT } from '../src/providers/deepgram-stt';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';
import { CartesiaTTS } from '../src/providers/cartesia-tts';

// ── Validate env vars ───────────────────────────────────────────────────────

const required = [
  'DTELECOM_API_KEY',
  'DTELECOM_API_SECRET',
  'DEEPGRAM_API_KEY',
  'OPENROUTER_API_KEY',
  'CARTESIA_API_KEY',
  'CARTESIA_VOICE_ID',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const roomName = process.env.ROOM_NAME ?? 'e2e-test';
const llmModel = process.env.LLM_MODEL ?? 'openai/gpt-4o';

// ── Setup ───────────────────────────────────────────────────────────────────

setLogLevel('info');

const agent = new VoiceAgent({
  stt: new DeepgramSTT({
    apiKey: process.env.DEEPGRAM_API_KEY!,
    model: 'nova-2',
    language: 'en',
  }),
  llm: new OpenRouterLLM({
    apiKey: process.env.OPENROUTER_API_KEY!,
    model: llmModel,
    maxTokens: 200,
    temperature: 0.7,
  }),
  tts: new CartesiaTTS({
    apiKey: process.env.CARTESIA_API_KEY!,
    voiceId: process.env.CARTESIA_VOICE_ID!,
  }),
  instructions: `You are a friendly voice assistant being tested in an end-to-end scenario.
Keep responses short (1-2 sentences). Respond naturally to whatever the user says.`,
  respondMode: 'always',
});

// ── Latency tracking ────────────────────────────────────────────────────────

let turnStart = 0;
const latencyLog: Array<{ text: string; totalMs: number }> = [];

// ── Events ──────────────────────────────────────────────────────────────────

agent.on('connected', () => {
  console.log('\n=== Agent connected ===');
  console.log(`Room: ${roomName}`);
  console.log('Waiting for a human to join and speak...\n');
});

agent.on('transcription', ({ text, isFinal, speaker }) => {
  if (isFinal) {
    turnStart = performance.now();
    console.log(`[STT final] [${speaker}]: ${text}`);
  } else {
    console.log(`[STT interim] [${speaker}]: ${text}`);
  }
});

agent.on('response', (text) => {
  const elapsed = turnStart > 0 ? performance.now() - turnStart : 0;
  console.log(`[Response] (${elapsed.toFixed(0)}ms total): ${text}`);
  if (turnStart > 0) {
    latencyLog.push({ text: text.slice(0, 60), totalMs: elapsed });
  }
});

agent.on('speaking', (isSpeaking) => {
  console.log(`[Speaking] ${isSpeaking ? 'started' : 'stopped'}`);
});

agent.on('error', (error) => {
  console.error('[Error]', error.message);
});

agent.on('disconnected', (reason) => {
  console.log(`[Disconnected] ${reason ?? 'unknown'}`);
});

// ── Start ───────────────────────────────────────────────────────────────────

console.log(`Starting e2e test agent in room "${roomName}"...`);
console.log(`LLM model: ${llmModel}`);

await agent.start({
  room: roomName,
  apiKey: process.env.DTELECOM_API_KEY!,
  apiSecret: process.env.DTELECOM_API_SECRET!,
  identity: 'e2e-test-agent',
  name: 'E2E Test Agent',
});

// ── Graceful shutdown ───────────────────────────────────────────────────────

process.on('SIGINT', async () => {
  console.log('\nShutting down...');

  if (latencyLog.length > 0) {
    console.log('\n=== Latency Summary ===');
    for (const entry of latencyLog) {
      console.log(`  ${entry.totalMs.toFixed(0)}ms — "${entry.text}"`);
    }
    const avg = latencyLog.reduce((s, e) => s + e.totalMs, 0) / latencyLog.length;
    console.log(`  Average: ${avg.toFixed(0)}ms (${latencyLog.length} turns)`);
  }

  await agent.stop();
  process.exit(0);
});
