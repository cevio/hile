import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConfigAggregator,
  createRuntimeReloader,
} from './index';

afterEach(() => {
  vi.useRealTimers();
});

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('RuntimeReloader', () => {
  it('debounces burst updates and reloads only the latest input', async () => {
    vi.useFakeTimers();
    const created: number[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      debounceMs: 20,
      create: async value => {
        created.push(value);
        return { value };
      },
    });

    void reloader.update(1);
    void reloader.update(2);
    const done = reloader.update(3);

    await vi.advanceTimersByTimeAsync(19);
    expect(created).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(created).toEqual([3]);
    expect(reloader.current()).toEqual({ value: 3 });
  });

  it('resets the debounce timer when new updates arrive before reload starts', async () => {
    vi.useFakeTimers();
    const created: number[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      debounceMs: 20,
      create: async value => {
        created.push(value);
        return { value };
      },
    });

    void reloader.update(1);
    await vi.advanceTimersByTimeAsync(19);
    const done = reloader.update(2);
    await vi.advanceTimersByTimeAsync(19);
    expect(created).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await done;

    expect(created).toEqual([2]);
  });

  it('runs one follow-up reload with the latest input after an in-flight reload', async () => {
    let releaseFirst!: () => void;
    const firstCreateStarted = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const created: number[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => {
        created.push(value);
        if (value === 1) await firstCreateStarted;
        return { value };
      },
    });

    const first = reloader.update(1);
    await tick();

    void reloader.update(2);
    const latest = reloader.update(3);
    releaseFirst();

    await first;
    await latest;

    expect(created).toEqual([1, 3]);
    expect(reloader.current()).toEqual({ value: 3 });
  });

  it('keeps the current runtime when create fails', async () => {
    const errors: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => {
        if (value === 2) throw new Error('bad config');
        return { value };
      },
      onError: error => errors.push((error as Error).message),
    });

    await reloader.update(1);
    await expect(reloader.update(2)).rejects.toThrow('bad config');

    expect(reloader.current()).toEqual({ value: 1 });
    expect(errors).toEqual(['bad config']);
  });

  it('rejects a started update when create fails even if a later update succeeds', async () => {
    let releaseFirst!: () => void;
    const firstCreateStarted = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => {
        if (value === 1) {
          await firstCreateStarted;
          throw new Error('first failed');
        }
        return { value };
      },
    });

    const first = reloader.update(1).then(
      () => 'resolved',
      error => (error as Error).message,
    );
    await tick();
    const second = reloader.update(2);
    releaseFirst();

    await expect(first).resolves.toBe('first failed');
    await expect(second).resolves.toBeUndefined();
    expect(reloader.current()).toEqual({ value: 2 });
  });

  it('rejects superseded pending updates when the final pending reload fails', async () => {
    vi.useFakeTimers();
    const reloader = createRuntimeReloader<number, { value: number }>({
      debounceMs: 10,
      create: async value => {
        if (value === 2) throw new Error('second failed');
        return { value };
      },
    });

    const first = reloader.update(1).then(
      () => 'resolved',
      error => (error as Error).message,
    );
    const second = reloader.update(2).then(
      () => 'resolved',
      error => (error as Error).message,
    );

    await vi.advanceTimersByTimeAsync(10);

    await expect(first).resolves.toBe('second failed');
    await expect(second).resolves.toBe('second failed');
    expect(reloader.current()).toBeUndefined();
  });

  it('switches to the new runtime before disposing the old runtime', async () => {
    const seenDuringDispose: Array<{ value: number } | undefined> = [];
    const disposeErrors: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => ({ value }),
      dispose: async old => {
        seenDuringDispose.push(reloader.current());
        if (old.value === 1) throw new Error('dispose failed');
      },
      onError: (error, context) => {
        disposeErrors.push(`${context.stage}:${(error as Error).message}`);
      },
    });

    await reloader.update(1);
    await reloader.update(2);

    expect(seenDuringDispose).toEqual([{ value: 2 }]);
    expect(reloader.current()).toEqual({ value: 2 });
    expect(disposeErrors).toEqual(['dispose:dispose failed']);
  });

  it('suppresses unchanged JSON-like configs by default', async () => {
    const created: unknown[] = [];
    const reloader = createRuntimeReloader<unknown, unknown>({
      create: async value => {
        created.push(value);
        return value;
      },
    });

    await reloader.update({ mysql: { port: 3306, host: 'db' } });
    await reloader.update({ mysql: { host: 'db', port: 3306 } });

    expect(created).toEqual([{ mysql: { port: 3306, host: 'db' } }]);
  });

  it('detects in-place object mutations with the default stable signature', async () => {
    const created: unknown[] = [];
    const reloader = createRuntimeReloader<unknown, unknown>({
      create: async value => {
        created.push(value);
        return value;
      },
    });
    const config = { mysql: { host: 'db-a', port: 3306 } };

    await reloader.update(config);
    config.mysql.host = 'db-b';
    await reloader.update(config);

    expect(created).toHaveLength(2);
  });

  it('treats unsupported compare values as changed and reports compare errors', async () => {
    const compareErrors: string[] = [];
    const created: unknown[] = [];
    const reloader = createRuntimeReloader<unknown, unknown>({
      create: async value => {
        created.push(value);
        return value;
      },
      onCompareError: error => compareErrors.push((error as Error).message),
    });

    await reloader.update(new Map([['a', 1]]));
    await reloader.update(new Map([['a', 1]]));

    expect(created).toHaveLength(2);
    expect(compareErrors.length).toBeGreaterThan(0);
  });

  it('rejects updates after stop and disposes current runtime', async () => {
    const disposed: number[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => ({ value }),
      dispose: async runtime => {
        disposed.push(runtime.value);
      },
    });

    await reloader.update(1);
    await reloader.stop();

    await expect(reloader.update(2)).rejects.toThrow(/stopped/i);
    expect(reloader.current()).toBeUndefined();
    expect(disposed).toEqual([1]);
  });

  it('resolves pending update waiters only after stop disposal finishes', async () => {
    const events: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      debounceMs: 20,
      create: async value => ({ value }),
      dispose: async () => {
        await tick();
        events.push('disposed');
      },
    });

    await reloader.update(1);
    const update = reloader.update(2).then(() => {
      events.push('update resolved');
    });
    await tick();
    const stopped = reloader.stop();

    await update;
    await stopped;

    expect(events).toEqual(['disposed', 'update resolved']);
  });

  it('aborts an in-flight create when stopped', async () => {
    const events: string[] = [];
    const errors: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async (_, context) => new Promise((_, reject) => {
        context.signal.addEventListener('abort', () => {
          events.push('aborted');
          reject(new Error('create aborted'));
        }, { once: true });
      }),
      onError: error => errors.push((error as Error).message),
    });

    const update = reloader.update(1);
    await tick();
    await reloader.stop();
    await update;

    expect(events).toEqual(['aborted']);
    expect(errors).toEqual([]);
  });

  it('disposes a runtime that resolves after create timeout', async () => {
    let releaseCreate!: () => void;
    const createGate = new Promise<void>(resolve => {
      releaseCreate = resolve;
    });
    const disposed: number[] = [];
    const errors: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      createTimeoutMs: 1,
      create: async value => {
        await createGate;
        return { value };
      },
      dispose: async runtime => {
        disposed.push(runtime.value);
      },
      onError: error => errors.push((error as Error).message),
    });

    await expect(reloader.update(1)).rejects.toThrow('RuntimeReloader create timed out');
    releaseCreate();
    await tick();

    expect(errors).toEqual(['RuntimeReloader create timed out']);
    expect(reloader.current()).toBeUndefined();
    expect(disposed).toEqual([1]);
  });

  it('resolves update when only old runtime disposal fails', async () => {
    const errors: string[] = [];
    const reloader = createRuntimeReloader<number, { value: number }>({
      create: async value => ({ value }),
      dispose: async () => {
        throw new Error('dispose failed');
      },
      onError: error => errors.push((error as Error).message),
    });

    await reloader.update(1);
    await expect(reloader.update(2)).resolves.toBeUndefined();

    expect(reloader.current()).toEqual({ value: 2 });
    expect(errors).toEqual(['dispose failed']);
  });
});

describe('ConfigAggregator', () => {
  it('waits for required keys before emitting a complete config', async () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const source = createConfigAggregator({
      required: ['mysql', 'redis'],
      defaults: { feature: { enabled: true } },
      debounceMs: 10,
    });
    source.onChange(config => emitted.push(config));

    source.set('mysql', { host: 'db' });
    await vi.advanceTimersByTimeAsync(10);
    expect(emitted).toEqual([]);

    source.set('redis', { host: 'cache' });
    await vi.advanceTimersByTimeAsync(10);

    expect(emitted).toEqual([
      {
        feature: { enabled: true },
        mysql: { host: 'db' },
        redis: { host: 'cache' },
      },
    ]);
  });

  it('coalesces multiple key updates and emits only the latest full config', async () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const source = createConfigAggregator({
      required: ['mysql', 'redis'],
      debounceMs: 20,
    });
    source.onChange(config => emitted.push(config));

    source.set('mysql', { host: 'db-a' });
    source.set('redis', { host: 'cache-a' });
    source.set('mysql', { host: 'db-b' });

    await vi.advanceTimersByTimeAsync(20);

    expect(emitted).toEqual([
      {
        mysql: { host: 'db-b' },
        redis: { host: 'cache-a' },
      },
    ]);
  });

  it('resets debounce when required keys are updated again before emitting', async () => {
    vi.useFakeTimers();
    const emitted: unknown[] = [];
    const source = createConfigAggregator({
      required: ['mysql'],
      debounceMs: 20,
    });
    source.onChange(config => emitted.push(config));

    source.set('mysql', { host: 'db-a' });
    await vi.advanceTimersByTimeAsync(19);
    source.set('mysql', { host: 'db-b' });
    await vi.advanceTimersByTimeAsync(19);
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);

    expect(emitted).toEqual([{ mysql: { host: 'db-b' } }]);
  });

  it('suppresses unchanged emitted configs and treats undefined as an explicit value', async () => {
    const emitted: unknown[] = [];
    const source = createConfigAggregator({
      required: ['mysql', 'feature'],
    });
    source.onChange(config => emitted.push(config));

    source.set('mysql', { host: 'db', port: 3306 });
    source.set('feature', undefined);
    await source.flush();
    source.set('mysql', { port: 3306, host: 'db' });
    await source.flush();

    expect(emitted).toEqual([
      {
        mysql: { host: 'db', port: 3306 },
        feature: undefined,
      },
    ]);
  });

  it('unset removes a required key and prevents emits until it is set again', async () => {
    const emitted: unknown[] = [];
    const source = createConfigAggregator({
      required: ['mysql', 'redis'],
    });
    source.onChange(config => emitted.push(config));

    source.set('mysql', { host: 'db' });
    source.set('redis', { host: 'cache-a' });
    await source.flush();
    source.unset('redis');
    await source.flush();
    source.set('mysql', { host: 'db-b' });
    await source.flush();
    source.set('redis', { host: 'cache-b' });
    await source.flush();

    expect(emitted).toEqual([
      { mysql: { host: 'db' }, redis: { host: 'cache-a' } },
      { mysql: { host: 'db-b' }, redis: { host: 'cache-b' } },
    ]);
  });

  it('does not commit the last signature when a listener fails', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const source = createConfigAggregator<{ mysql: { host: string } }>({
      required: ['mysql'],
      onError: error => errors.push((error as Error).message),
    });
    source.onChange(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('listener failed');
    });

    source.set('mysql', { host: 'db' });
    await expect(source.flush()).rejects.toThrow('listener failed');
    source.set('mysql', { host: 'db' });
    await source.flush();

    expect(attempts).toBe(2);
    expect(errors).toEqual(['listener failed']);
  });

  it('serializes concurrent flushes so older emits cannot overwrite newer signatures', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const source = createConfigAggregator<{ value: number }>({
      required: ['value'],
    });
    source.onChange(async config => {
      events.push(`start:${config.value}`);
      if (config.value === 1 && events.length === 1) await firstGate;
      events.push(`finish:${config.value}`);
    });

    source.set('value', 1);
    const firstFlush = source.flush();
    await tick();
    source.set('value', 2);
    const secondFlush = source.flush();
    await tick();

    expect(events).toEqual(['start:1']);

    releaseFirst();
    await firstFlush;
    await secondFlush;
    source.set('value', 1);
    await source.flush();

    expect(events).toEqual([
      'start:1',
      'finish:1',
      'start:2',
      'finish:2',
      'start:1',
      'finish:1',
    ]);
  });

  it('retries the same config after a reloader create failure', async () => {
    let attempts = 0;
    const source = createConfigAggregator<{ mysql: { host: string } }>({
      required: ['mysql'],
    });
    const reloader = createRuntimeReloader<{ mysql: { host: string } }, { host: string }>({
      create: async config => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return { host: config.mysql.host };
      },
    });
    source.onChange(config => reloader.update(config));

    source.set('mysql', { host: 'db' });
    await expect(source.flush()).rejects.toThrow('transient');
    source.set('mysql', { host: 'db' });
    await source.flush();

    expect(attempts).toBe(2);
    expect(reloader.current()).toEqual({ host: 'db' });
  });

  it('does not commit a superseded config when the emitted latest reload fails', async () => {
    vi.useFakeTimers();
    const attempts: number[] = [];
    const source = createConfigAggregator<{ value: number }>({
      required: ['value'],
    });
    const reloader = createRuntimeReloader<{ value: number }, { value: number }>({
      debounceMs: 10,
      create: async config => {
        attempts.push(config.value);
        if (config.value === 2) throw new Error('second failed');
        return { value: config.value };
      },
    });
    source.onChange(config => reloader.update(config));

    source.set('value', 1);
    source.set('value', 2);
    const flush = source.flush().then(
      () => 'resolved',
      error => (error as Error).message,
    );
    await vi.advanceTimersByTimeAsync(10);

    await expect(flush).resolves.toBe('second failed');
    expect(attempts).toEqual([2]);
    expect(reloader.current()).toBeUndefined();

    source.set('value', 1);
    const retry = source.flush();
    await vi.advanceTimersByTimeAsync(10);
    await retry;

    expect(attempts).toEqual([2, 1]);
    expect(reloader.current()).toEqual({ value: 1 });
  });
});
