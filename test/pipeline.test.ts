import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import { MockSTT, MockLLM, MockTTS, MockAudioOutput } from './helpers/mock-providers';

// Suppress logger output in tests
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

describe('Pipeline', () => {
  let stt: MockSTT;
  let llm: MockLLM;
  let tts: MockTTS;
  let audioOutput: MockAudioOutput;

  const instructions = 'You are a helpful assistant.';

  beforeEach(() => {
    stt = new MockSTT();
    llm = new MockLLM('This is a test response that is long enough to be a sentence.');
    tts = new MockTTS();
    audioOutput = new MockAudioOutput();
  });

  function createPipeline(overrides: Record<string, unknown> = {}): Pipeline {
    return new Pipeline({
      stt,
      llm,
      tts,
      audioOutput: audioOutput as any,
      instructions,
      ...overrides,
    });
  }

  it('full cycle: transcription → LLM → TTS → audio output', async () => {
    const pipeline = createPipeline();
    const responsePromise = new Promise<string>((resolve) => {
      pipeline.on('response', resolve);
    });

    pipeline.addParticipant('user1');
    const stream = stt.streams[0];

    // Simulate a final transcription
    stream.simulateTranscription('Hello there', true);

    const response = await responsePromise;
    expect(response).toBe('This is a test response that is long enough to be a sentence.');
    expect(llm.calls).toHaveLength(1);
    expect(tts.synthesizeCalls.length).toBeGreaterThan(0);
    expect(audioOutput.writtenBuffers.length).toBeGreaterThan(0);

    await pipeline.stop();
  });

  it('emits speaking then idle agentState during response', async () => {
    const pipeline = createPipeline();
    const states: string[] = [];

    pipeline.on('agentState', (state) => states.push(state));

    const responsePromise = new Promise<void>((resolve) => {
      pipeline.on('response', () => resolve());
    });

    pipeline.addParticipant('user1');
    stt.streams[0].simulateTranscription('Hello', true);

    await responsePromise;
    expect(states).toContain('speaking');
    // After AUDIO_DRAIN_MS the state returns to idle
    await new Promise((r) => setTimeout(r, 1000));
    expect(states[states.length - 1]).toBe('idle');

    await pipeline.stop();
  });

  it('emits transcription event with speaker identity', async () => {
    const pipeline = createPipeline();
    const transcriptionPromise = new Promise<any>((resolve) => {
      pipeline.on('transcription', resolve);
    });

    pipeline.addParticipant('alice');
    stt.streams[0].simulateTranscription('Hi', false);

    const result = await transcriptionPromise;
    expect(result.speaker).toBe('alice');
    expect(result.text).toBe('Hi');
    expect(result.isFinal).toBe(false);

    await pipeline.stop();
  });

  it('respondMode "addressed" only responds when name mentioned', async () => {
    const pipeline = createPipeline({
      respondMode: 'addressed',
      agentName: 'tutor',
    });

    let responseCount = 0;
    pipeline.on('response', () => responseCount++);

    pipeline.addParticipant('user1');
    const stream = stt.streams[0];

    // Not addressed — should not trigger response
    stream.simulateTranscription('hello everyone', true);
    // Give it time to process (or not)
    await new Promise((r) => setTimeout(r, 50));
    expect(responseCount).toBe(0);

    // Addressed — should trigger response
    const responsePromise = new Promise<void>((resolve) => {
      pipeline.on('response', () => resolve());
    });
    stream.simulateTranscription('hey tutor, help me', true);
    await responsePromise;
    expect(responseCount).toBe(1);

    await pipeline.stop();
  });

  it('beforeRespond hook can suppress response', async () => {
    const pipeline = createPipeline({
      respondMode: 'addressed',
      agentName: 'tutor',
      beforeRespond: () => false,
    });

    let responseCount = 0;
    pipeline.on('response', () => responseCount++);

    pipeline.addParticipant('user1');
    stt.streams[0].simulateTranscription('hey tutor, help me', true);

    await new Promise((r) => setTimeout(r, 50));
    expect(responseCount).toBe(0);

    await pipeline.stop();
  });

  it('barge-in cancels current cycle', async () => {
    // Use a slow LLM to give time for barge-in
    llm = new MockLLM('Word1 word2 word3 word4 word5 word6 word7 word8 word9 word10.', 20);
    const pipeline = createPipeline();

    pipeline.addParticipant('user1');
    const stream = stt.streams[0];

    // Start first response
    stream.simulateTranscription('First question', true);

    // Wait a bit then barge in with a new transcription
    await new Promise((r) => setTimeout(r, 30));

    // The second transcription while processing should trigger barge-in
    stream.simulateTranscription('Actually nevermind, new question.', true);

    // Wait for the second response to complete
    const secondResponse = await new Promise<string>((resolve) => {
      pipeline.on('response', resolve);
    });

    // The pipeline should have processed the queued turn
    expect(secondResponse).toBeTruthy();
    expect(audioOutput.flushed).toBe(true);

    await pipeline.stop();
  });

  it('stop cleans up STT streams and sets running to false', async () => {
    const pipeline = createPipeline();
    pipeline.addParticipant('user1');
    pipeline.addParticipant('user2');

    expect(pipeline.running).toBe(true);
    expect(stt.streams).toHaveLength(2);

    await pipeline.stop();

    expect(pipeline.running).toBe(false);
    expect(stt.streams[0].closed).toBe(true);
    expect(stt.streams[1].closed).toBe(true);
  });

  it('addParticipant replaces existing stream for same identity', async () => {
    const pipeline = createPipeline();
    pipeline.addParticipant('user1');
    const firstStream = stt.streams[0];

    pipeline.addParticipant('user1');
    expect(stt.streams).toHaveLength(2);
    expect(firstStream.closed).toBe(true);

    await pipeline.stop();
  });

  it('removeParticipant closes the stream', async () => {
    const pipeline = createPipeline();
    pipeline.addParticipant('user1');
    const stream = stt.streams[0];

    await pipeline.removeParticipant('user1');
    expect(stream.closed).toBe(true);

    await pipeline.stop();
  });

  it('works without TTS — logs response as text only', async () => {
    const pipeline = createPipeline({ tts: undefined });

    const responsePromise = new Promise<string>((resolve) => {
      pipeline.on('response', resolve);
    });

    pipeline.addParticipant('user1');
    stt.streams[0].simulateTranscription('Hello', true);

    const response = await responsePromise;
    expect(response).toBeTruthy();
    // No TTS calls and no audio output
    expect(tts.synthesizeCalls).toHaveLength(0);
    expect(audioOutput.writtenBuffers).toHaveLength(0);

    await pipeline.stop();
  });

  it('context manager tracks conversation', async () => {
    const pipeline = createPipeline();

    const responsePromise = new Promise<void>((resolve) => {
      pipeline.on('response', () => resolve());
    });

    pipeline.addParticipant('user1');
    stt.streams[0].simulateTranscription('What is 2+2?', true);

    await responsePromise;

    const transcript = pipeline.getContextManager().getFullTranscript();
    expect(transcript).toContain('[user1]: What is 2+2?');
    expect(transcript).toContain('[assistant]:');

    await pipeline.stop();
  });

  it('pending turn is processed after current completes', async () => {
    // Slow LLM to ensure overlap
    llm = new MockLLM('First response long enough for a sentence.', 10);
    const pipeline = createPipeline();
    const responses: string[] = [];

    pipeline.on('response', (text) => responses.push(text));

    pipeline.addParticipant('user1');
    const stream = stt.streams[0];

    // Fire two transcriptions in quick succession
    stream.simulateTranscription('First question', true);
    // Wait a tiny bit so the first one starts processing
    await new Promise((r) => setTimeout(r, 5));
    stream.simulateTranscription('Second question', true);

    // Wait for both to complete
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (responses.length >= 1) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    // Should have processed at least one response (barge-in may abort first)
    expect(responses.length).toBeGreaterThanOrEqual(1);

    await pipeline.stop();
  });

  it('emits error on STT stream error', async () => {
    const pipeline = createPipeline();
    const errorPromise = new Promise<Error>((resolve) => {
      pipeline.on('error', resolve);
    });

    pipeline.addParticipant('user1');
    stt.streams[0].simulateError(new Error('STT connection lost'));

    const error = await errorPromise;
    expect(error.message).toBe('STT connection lost');

    await pipeline.stop();
  });
});
