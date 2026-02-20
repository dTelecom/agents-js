/**
 * Fully automated end-to-end test — no human required.
 *
 * Flow:
 *   1. Pre-synthesize a test phrase using Cartesia TTS (simulated human voice)
 *   2. Connect a "human simulator" participant and publish its audio track
 *   3. Start the VoiceAgent — it auto-subscribes to the human's existing track
 *   4. Send silence lead-in to warm the audio path + Deepgram connection
 *   5. Play the pre-synthesized speech
 *   6. Wait for the agent to transcribe → respond via LLM → speak via TTS
 *   7. Report latency and verify the full pipeline worked
 *   8. Clean up
 *
 * Requires a .env file in the project root (see .env.example).
 *
 * Usage:
 *   npx tsx examples/e2e-auto-test.ts
 */

import 'dotenv/config';
import { VoiceAgent, setLogLevel } from '../src/index';
import { DeepgramSTT } from '../src/providers/deepgram-stt';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';
import { CartesiaTTS } from '../src/providers/cartesia-tts';
import {
  Room,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackSource,
} from '@dtelecom/server-sdk-node';
import { AccessToken } from '@dtelecom/server-sdk-js';

// ─── Config (from .env) ─────────────────────────────────────────────────────

const required = [
  'DTELECOM_API_KEY',
  'DTELECOM_API_SECRET',
  'DEEPGRAM_API_KEY',
  'OPENROUTER_API_KEY',
  'CARTESIA_API_KEY',
] as const;

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const DTELECOM_API_KEY = process.env.DTELECOM_API_KEY!;
const DTELECOM_API_SECRET = process.env.DTELECOM_API_SECRET!;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY!;
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY!;
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY!;

// Agent voice (from env or default)
const AGENT_VOICE_ID = process.env.CARTESIA_VOICE_ID ?? 'c99d36f3-5ffd-4253-803a-535c1bc9c306'; // Griffin - Narrator (en)
// Human simulator voice (different from agent so we can tell them apart)
const HUMAN_VOICE_ID = 'bbee10a8-4f08-4c5c-8282-e69299115055'; // Ben - Helpful Man (en)

const ROOM_NAME = `e2e-auto-${Date.now()}`;
const TEST_PHRASE = 'Hello there! What is two plus two?';
const TIMEOUT_MS = 30_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(tag: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] [${tag}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Collect all PCM16 chunks from the TTS async generator into a single Buffer. */
async function synthesizeToBuffer(tts: CartesiaTTS, text: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of tts.synthesize(text)) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Play a PCM16 buffer through an AudioSource at real-time pace (20ms frames). */
async function playAudio(source: AudioSource, pcm16: Buffer): Promise<void> {
  const FRAME_SAMPLES = 320; // 20ms at 16kHz

  // Copy to aligned buffer
  const aligned = Buffer.alloc(pcm16.byteLength);
  pcm16.copy(aligned);
  const samples = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);

  let offset = 0;
  while (offset < samples.length) {
    const end = Math.min(offset + FRAME_SAMPLES, samples.length);
    const frameSamples = samples.subarray(offset, end);
    const frame = new AudioFrame(frameSamples, 16000, 1, frameSamples.length);
    await source.captureFrame(frame);
    await sleep(20); // Real-time pacing
    offset = end;
  }

  source.flush();
}

/** Send silence at real-time pace through an AudioSource. */
async function playSilence(source: AudioSource, durationMs: number): Promise<void> {
  const FRAME_SAMPLES = 320; // 20ms at 16kHz
  const numFrames = Math.ceil(durationMs / 20);
  const silenceSamples = new Int16Array(FRAME_SAMPLES); // zeros = silence

  for (let i = 0; i < numFrames; i++) {
    const frame = new AudioFrame(silenceSamples, 16000, 1, FRAME_SAMPLES);
    await source.captureFrame(frame);
    await sleep(20);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  setLogLevel('info');

  console.log('');
  console.log('=== Automated E2E Test ===');
  console.log(`Room:    ${ROOM_NAME}`);
  console.log(`Phrase:  "${TEST_PHRASE}"`);
  console.log('');

  // ── Step 1: Pre-synthesize the human's speech ────────────────────────────

  log('SYNTH', 'Pre-synthesizing human test phrase...');
  const humanTTS = new CartesiaTTS({
    apiKey: CARTESIA_API_KEY,
    voiceId: HUMAN_VOICE_ID,
    sampleRate: 16000,
  });

  const humanAudio = await synthesizeToBuffer(humanTTS, TEST_PHRASE);
  const audioDurationMs = (humanAudio.byteLength / 2) / 16000 * 1000;
  log('SYNTH', `Done: ${humanAudio.byteLength} bytes, ${audioDurationMs.toFixed(0)}ms of audio`);

  // ── Step 2: Connect the human simulator FIRST ────────────────────────────
  // The human must be in the room before the agent starts, so the agent
  // auto-subscribes to the human's existing track during its start() flow.

  log('HUMAN', 'Connecting human simulator...');
  const humanRoom = new Room();

  const humanToken = new AccessToken(DTELECOM_API_KEY, DTELECOM_API_SECRET, {
    identity: 'e2e-human',
    name: 'E2E Human',
  });
  humanToken.addGrant({
    roomJoin: true,
    room: ROOM_NAME,
    canPublish: true,
    canSubscribe: true,
  });

  const humanWsUrl = await humanToken.getWsUrl();
  const humanJwt = humanToken.toJwt();
  await humanRoom.connect(humanWsUrl, humanJwt, { autoSubscribe: true });
  log('HUMAN', 'Connected to room');

  // Publish human audio track
  const humanAudioSource = new AudioSource(16000, 1);
  const humanTrack = LocalAudioTrack.createAudioTrack('human-mic', humanAudioSource);
  await humanRoom.localParticipant.publishTrack(humanTrack, {
    name: 'human-mic',
    source: TrackSource.MICROPHONE,
  });
  log('HUMAN', 'Audio track published');

  // Wait for the track to be fully negotiated before starting the agent
  log('HUMAN', 'Waiting 3s for track to settle...');
  await sleep(3000);

  // ── Step 3: Start the voice agent ────────────────────────────────────────
  // The agent will auto-subscribe to the human's already-published track.

  log('AGENT', 'Starting voice agent...');
  const agent = new VoiceAgent({
    stt: new DeepgramSTT({
      apiKey: DEEPGRAM_API_KEY,
      model: 'nova-2',
      language: 'en',
      utteranceEndMs: 1000,
    }),
    llm: new OpenRouterLLM({
      apiKey: OPENROUTER_API_KEY,
      model: 'openai/gpt-4o-mini',
      maxTokens: 150,
      temperature: 0.7,
    }),
    tts: new CartesiaTTS({
      apiKey: CARTESIA_API_KEY,
      voiceId: AGENT_VOICE_ID,
      sampleRate: 16000,
    }),
    instructions: 'You are a helpful assistant being tested. Keep responses short — one sentence.',
    respondMode: 'always',
  });

  // Track events
  let agentResponse = '';
  let transcribedText = '';
  let tResponseStart = 0;
  let tTranscription = 0;

  agent.on('transcription', ({ text, isFinal, speaker }) => {
    if (isFinal && speaker !== 'e2e-agent') {
      tTranscription = performance.now();
      transcribedText = text;
      log('STT', `Final: [${speaker}] "${text}"`);
    }
  });

  agent.on('response', (text) => {
    if (!agentResponse) {
      tResponseStart = performance.now();
    }
    agentResponse = text;
    log('RESPONSE', text);
  });

  agent.on('speaking', (s) => {
    log('SPEAKING', s ? 'started' : 'stopped');
  });

  agent.on('error', (err) => {
    log('ERROR', err.message);
  });

  const connectedPromise = new Promise<void>((resolve) => {
    agent.on('connected', resolve);
  });

  await agent.start({
    room: ROOM_NAME,
    apiKey: DTELECOM_API_KEY,
    apiSecret: DTELECOM_API_SECRET,
    identity: 'e2e-agent',
    name: 'E2E Test Agent',
  });

  await connectedPromise;
  log('AGENT', 'Agent connected and listening');

  // ── Step 4: Warm up the audio path ───────────────────────────────────────
  // Send silence at real-time pace. This ensures:
  // - The SFU is forwarding audio from human → agent
  // - The agent's AudioInput is receiving frames
  // - The Deepgram WebSocket has time to connect and prime
  // The silence is paced as proper 20ms frames (same as real speech).

  log('HUMAN', 'Sending 3s silence lead-in to warm audio path + STT...');
  await playSilence(humanAudioSource, 3000);
  log('HUMAN', 'Silence lead-in done');

  // ── Step 5: Play the pre-synthesized audio ───────────────────────────────

  const tPlayStart = performance.now();
  log('HUMAN', `Playing test phrase (${audioDurationMs.toFixed(0)}ms of audio)...`);
  await playAudio(humanAudioSource, humanAudio);

  // Send trailing silence so Deepgram gets a clean end-of-speech signal
  await playSilence(humanAudioSource, 1500);
  const tPlayEnd = performance.now();
  log('HUMAN', `Audio playback done (${(tPlayEnd - tPlayStart).toFixed(0)}ms wall time)`);

  // ── Step 6: Wait for agent response ──────────────────────────────────────

  log('WAIT', `Waiting up to ${TIMEOUT_MS / 1000}s for agent response...`);
  const deadline = Date.now() + TIMEOUT_MS;

  while (!agentResponse && Date.now() < deadline) {
    await sleep(200);
  }

  // ── Step 7: Report results ───────────────────────────────────────────────

  console.log('');
  console.log('=== Results ===');

  if (agentResponse) {
    console.log(`  Status:        PASS`);
    console.log(`  Transcribed:   "${transcribedText}"`);
    console.log(`  Agent said:    "${agentResponse}"`);

    if (tTranscription && tPlayStart) {
      console.log(`  STT latency:   ${(tTranscription - tPlayStart).toFixed(0)}ms (from play start to final transcription)`);
    }
    if (tResponseStart && tPlayStart) {
      console.log(`  Total latency: ${(tResponseStart - tPlayStart).toFixed(0)}ms (from play start to response)`);
    }
  } else {
    console.log(`  Status:        FAIL`);
    console.log(`  Transcribed:   "${transcribedText || '(nothing)'}"`);
    console.log(`  Agent said:    (no response within ${TIMEOUT_MS / 1000}s)`);
  }

  console.log('');

  // ── Step 8: Clean up ─────────────────────────────────────────────────────

  log('CLEANUP', 'Disconnecting...');
  await humanRoom.disconnect();
  await agent.stop();
  log('CLEANUP', 'Done');

  process.exit(agentResponse ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
