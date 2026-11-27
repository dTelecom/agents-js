import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Pipeline } from '../src/core/pipeline';
import type { LLMPlugin } from '../src/core/types';
import { MockSTT, MockTTS, MockAudioOutput } from './helpers/mock-providers';

const logs = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../src/utils/logger', () => ({ createLogger: () => logs }));

describe('Pipeline interrupted event', () => {
  let pipeline: Pipeline;
  let stt: MockSTT;
  let events: string[];
  const flush = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    stt = new MockSTT();
    events = [];
  });
  afterEach(async () => {
    await pipeline?.stop();
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });

  function create(llm: LLMPlugin) {
    pipeline = new Pipeline({ stt, llm, tts: new MockTTS(100, 20), audioOutput: new MockAudioOutput() as any, instructions: 'Help.' });
    pipeline.on('agentState', (state) => events.push(state));
    pipeline.on('interrupted', () => events.push('interrupted'));
    pipeline.addParticipant('user');
  }

  it('is emitted once when the visitor cuts off a spoken reply, before the state returns to idle', async () => {
    create({ async *chat() { yield { type: 'token', token: 'This answer is long enough to be spoken for a while. ' }; } });
    stt.streams[0].simulateTranscription('Tell me something', true);
    for (let i = 0; i < 20 && !events.includes('speaking'); i++) await vi.advanceTimersByTimeAsync(50);
    expect(events).toContain('speaking');

    stt.streams[0].simulateTranscription('Wait', false);
    stt.streams[0].simulateTranscription('Wait, stop', false);
    await flush();

    expect(events.filter((e) => e === 'interrupted')).toHaveLength(1);
    const at = events.indexOf('interrupted');
    expect(events.indexOf('speaking')).toBeLessThan(at);
    expect(events.slice(at + 1)).toContain('idle');
  });

  it('is emitted when a final transcript cuts off a reply that already played', async () => {
    create({ async *chat() { yield { type: 'token', token: 'This answer is long enough to be spoken for a while. ' }; } });
    stt.streams[0].simulateTranscription('Tell me something', true);
    for (let i = 0; i < 20 && !events.includes('speaking'); i++) await vi.advanceTimersByTimeAsync(50);

    stt.streams[0].simulateTranscription('Another question', true);
    await flush();

    expect(events.filter((e) => e === 'interrupted')).toHaveLength(1);
  });

  it('is not emitted when a new question arrives while the agent is still thinking', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    create({ async *chat() { await gate; yield { type: 'token', token: 'An answer. ' }; } });
    stt.streams[0].simulateTranscription('First question', true);
    await flush();
    expect(events).toContain('thinking');

    stt.streams[0].simulateTranscription('Second question', true);
    await flush();
    release();
    await flush();

    expect(events).not.toContain('interrupted');
  });
});
