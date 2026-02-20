import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TurnDetector } from '../src/core/turn-detector';

describe('TurnDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires onTurnEnd after silence timeout', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('hello', true);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(800);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('does not fire before timeout elapses', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('hello', true);
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it('interim result resets the timer', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('hello', true);
    vi.advanceTimersByTime(500);

    // Interim resets timer
    td.handleTranscription('hello world', false);
    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();

    // Timer should NOT fire at original 800ms mark
    vi.advanceTimersByTime(300);
    expect(cb).not.toHaveBeenCalled();
  });

  it('forceTurnEnd calls callback immediately', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.forceTurnEnd();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('reset clears pending timer', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('hello', true);
    td.reset();

    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('custom silenceTimeoutMs works', () => {
    const td = new TurnDetector({ silenceTimeoutMs: 200 });
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('hello', true);
    vi.advanceTimersByTime(199);
    expect(cb).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('ignores empty text on final result', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('', true);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('ignores whitespace-only text on final result', () => {
    const td = new TurnDetector();
    const cb = vi.fn();
    td.onTurnEnd = cb;

    td.handleTranscription('   ', true);
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
  });

  it('returns false from handleTranscription (never returns true directly)', () => {
    const td = new TurnDetector();
    td.onTurnEnd = vi.fn();

    expect(td.handleTranscription('hello', true)).toBe(false);
    expect(td.handleTranscription('hello', false)).toBe(false);
  });
});
