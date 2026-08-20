import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeadlineScheduler } from './deadline-scheduler';

describe('DeadlineScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs deadlines in chronological order with one active system timer', async () => {
    vi.useFakeTimers();
    const scheduler = new DeadlineScheduler();
    const calls: string[] = [];

    scheduler.schedule(30, () => calls.push('third'));
    scheduler.schedule(10, () => calls.push('first'));
    scheduler.schedule(20, () => calls.push('second'));

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(calls).toEqual(['first', 'second', 'third']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reorders an existing deadline without scheduling it twice', async () => {
    vi.useFakeTimers();
    const scheduler = new DeadlineScheduler();
    const calls: string[] = [];
    const later = scheduler.schedule(50, () => calls.push('later'));
    const earlier = scheduler.schedule(100, () => calls.push('earlier'));

    scheduler.reschedule(earlier, 10);
    scheduler.reschedule(later, 100);

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual(['earlier']);
    await vi.advanceTimersByTimeAsync(90);
    expect(calls).toEqual(['earlier', 'later']);
  });

  it('removes cancelled deadlines and clear removes all timers', async () => {
    vi.useFakeTimers();
    const scheduler = new DeadlineScheduler();
    const calls: string[] = [];
    const cancelled = scheduler.schedule(10, () => calls.push('cancelled'));
    scheduler.schedule(20, () => calls.push('cleared'));

    scheduler.cancel(cancelled);
    expect(vi.getTimerCount()).toBe(1);
    scheduler.clear();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toEqual([]);
  });

  it('normalizes invalid internal delays without creating a rearm loop', async () => {
    vi.useFakeTimers();
    const scheduler = new DeadlineScheduler();
    const callback = vi.fn();

    scheduler.schedule(Number.POSITIVE_INFINITY, callback);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
