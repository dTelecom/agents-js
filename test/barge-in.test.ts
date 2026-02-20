import { describe, it, expect, vi } from 'vitest';
import { BargeIn } from '../src/core/barge-in';

describe('BargeIn', () => {
  it('startCycle returns an AbortSignal that is not aborted', () => {
    const bi = new BargeIn();
    const signal = bi.startCycle();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it('trigger aborts the signal', () => {
    const bi = new BargeIn();
    const signal = bi.startCycle();
    bi.trigger();
    expect(signal.aborted).toBe(true);
  });

  it('trigger sets interrupted to true', () => {
    const bi = new BargeIn();
    bi.startCycle();
    expect(bi.interrupted).toBe(false);
    bi.trigger();
    expect(bi.interrupted).toBe(true);
  });

  it('trigger calls onInterrupt callback', () => {
    const bi = new BargeIn();
    const cb = vi.fn();
    bi.onInterrupt = cb;

    bi.startCycle();
    bi.trigger();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('double trigger is no-op — onInterrupt called only once', () => {
    const bi = new BargeIn();
    const cb = vi.fn();
    bi.onInterrupt = cb;

    bi.startCycle();
    bi.trigger();
    bi.trigger();
    expect(cb).toHaveBeenCalledOnce();
  });

  it('reset clears interrupted state', () => {
    const bi = new BargeIn();
    bi.startCycle();
    bi.trigger();
    expect(bi.interrupted).toBe(true);

    bi.reset();
    expect(bi.interrupted).toBe(false);
  });

  it('new cycle after reset provides fresh signal', () => {
    const bi = new BargeIn();
    const signal1 = bi.startCycle();
    bi.trigger();
    expect(signal1.aborted).toBe(true);

    bi.reset();
    const signal2 = bi.startCycle();
    expect(signal2.aborted).toBe(false);
    expect(signal2).not.toBe(signal1);
  });

  it('trigger without startCycle does not throw', () => {
    const bi = new BargeIn();
    const cb = vi.fn();
    bi.onInterrupt = cb;
    bi.trigger();
    expect(bi.interrupted).toBe(true);
    expect(cb).toHaveBeenCalledOnce();
  });
});
