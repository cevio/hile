import { describe, expect, it } from 'vitest';
import { shallowRef } from '@vue/reactivity';
import {
  publishRef,
  reactiveConfig,
  reactiveReloader,
  topicRef,
  watchLatest,
  watchQueue,
  watchSerialLatest,
} from './index';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakePublisher<T> {
  public readonly updates: T[] = [];
  public unpublished = false;
  public unpublishAttempts = 0;
  public failUnpublish = false;
  public onUpdate?: (value: T) => Promise<void>;

  constructor(public readonly initial: T) {}

  async update(value: T) {
    this.updates.push(value);
    await this.onUpdate?.(value);
    return this;
  }

  async unpublish() {
    this.unpublishAttempts += 1;
    if (this.failUnpublish) throw new Error('unpublish failed');
    this.unpublished = true;
    return this;
  }
}

class FakeApplication {
  public readonly subscribers = new Map<string, Set<(value: any) => any>>();
  public readonly publishers = new Map<string, FakePublisher<any>>();
  public readonly unsubscribedTopics: string[] = [];
  public readonly unsubscribeAttempts: string[] = [];
  public failSubscribeTopic?: string;
  public failUnsubscribeTopics = new Set<string>();

  async subscribe<T>(topic: string, callback: (value: T) => any) {
    if (topic === this.failSubscribeTopic) {
      throw new Error(`subscribe failed: ${topic}`);
    }
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic)!.add(callback);
    return async () => {
      this.unsubscribeAttempts.push(topic);
      if (this.failUnsubscribeTopics.has(topic)) {
        throw new Error(`unsubscribe failed: ${topic}`);
      }
      this.subscribers.get(topic)?.delete(callback);
      this.unsubscribedTopics.push(topic);
    };
  }

  async publish<T>(topic: string, value: T) {
    const publisher = new FakePublisher(value);
    this.publishers.set(topic, publisher);
    return publisher;
  }

  emitTopic<T>(topic: string, value: T) {
    for (const callback of this.subscribers.get(topic) ?? []) {
      callback(value);
    }
  }
}

describe('async watch helpers', () => {
  it('watchLatest aborts stale async work and lets the latest value complete', async () => {
    const source = shallowRef(0);
    const first = deferred();
    const completed: number[] = [];
    const aborted: number[] = [];

    const stop = watchLatest(source, async (value, context) => {
      if (value === 1) {
        await first.promise;
      }
      if (context.signal.aborted) {
        aborted.push(value);
        return;
      }
      completed.push(value);
    });

    source.value = 1;
    await tick();
    source.value = 2;
    await tick();
    first.resolve();
    await tick();

    stop();
    expect(completed).toEqual([2]);
    expect(aborted).toEqual([1]);
  });

  it('watchLatest reports synchronous handler failures without stopping later runs', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];
    const reported: number[] = [];

    const stop = watchLatest(source, value => {
      handled.push(value);
      if (value === 1) throw new Error('sync handler failed');
    }, {
      onError: (_error, context) => reported.push(context.value),
    });

    source.value = 1;
    await tick();
    source.value = 2;
    await tick();

    stop();
    expect(handled).toEqual([1, 2]);
    expect(reported).toEqual([1]);
  });

  it('watchLatest skips stale work invalidated before the handler starts', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];

    const stop = watchLatest(source, value => {
      handled.push(value);
    });

    source.value = 1;
    source.value = 2;
    await tick();

    stop();
    expect(handled).toEqual([2]);
  });

  it('watchLatest respects once without aborting the first async run', async () => {
    const source = shallowRef(0);
    const release = deferred();
    const handled: number[] = [];
    const aborted: number[] = [];

    const stop = watchLatest(source, async (value, context) => {
      await release.promise;
      if (context.signal.aborted) {
        aborted.push(value);
        return;
      }
      handled.push(value);
    }, { once: true });

    source.value = 1;
    source.value = 2;
    await tick();
    release.resolve();
    await tick();

    stop();
    expect(handled).toEqual([1]);
    expect(aborted).toEqual([]);
  });

  it('watchLatest starts a single once run when there is only one change', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];

    const stop = watchLatest(source, value => {
      handled.push(value);
    }, { once: true });

    source.value = 1;
    await tick();

    stop();
    expect(handled).toEqual([1]);
  });

  it('watchLatest supports immediate once', async () => {
    const source = shallowRef(1);
    const handled: number[] = [];

    const stop = watchLatest(source, value => {
      handled.push(value);
    }, { immediate: true, once: true });

    source.value = 2;
    await tick();

    stop();
    expect(handled).toEqual([1]);
  });

  it('watchLatest skips a once run when stopped before the handler starts', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];

    const stop = watchLatest(source, value => {
      handled.push(value);
    }, { once: true });

    source.value = 1;
    stop();
    await tick();

    expect(handled).toEqual([]);
  });

  it('watchSerialLatest runs one in-flight task and then only the latest pending value', async () => {
    const source = shallowRef(0);
    const first = deferred();
    const handled: number[] = [];

    const stop = watchSerialLatest(source, async value => {
      handled.push(value);
      if (value === 1) {
        await first.promise;
      }
    });

    source.value = 1;
    await tick();
    source.value = 2;
    source.value = 3;
    await tick();
    first.resolve();
    await tick();
    await tick();

    stop();
    expect(handled).toEqual([1, 3]);
  });

  it('watchSerialLatest respects once', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];

    const stop = watchSerialLatest(source, value => {
      handled.push(value);
    }, { once: true });

    source.value = 1;
    source.value = 2;
    await tick();

    stop();
    expect(handled).toEqual([1]);
  });

  it('watchQueue serializes every observed value', async () => {
    const source = shallowRef(0);
    const first = deferred();
    const handled: number[] = [];

    const stop = watchQueue(source, async value => {
      handled.push(value);
      if (value === 1) {
        await first.promise;
      }
    });

    source.value = 1;
    await tick();
    source.value = 2;
    source.value = 3;
    first.resolve();
    await tick();
    await tick();

    stop();
    expect(handled).toEqual([1, 2, 3]);
  });

  it('watchQueue respects once', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];

    const stop = watchQueue(source, value => {
      handled.push(value);
    }, { once: true });

    source.value = 1;
    source.value = 2;
    await tick();

    stop();
    expect(handled).toEqual([1]);
  });

  it('keeps watcher scheduling alive when onError throws', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];
    const reported: number[] = [];

    const stop = watchSerialLatest(source, async value => {
      handled.push(value);
      if (value === 1) throw new Error('handler failed');
    }, {
      onError: (_error, context) => {
        reported.push(context.value);
        throw new Error('error reporter failed');
      },
    });

    source.value = 1;
    await tick();
    source.value = 2;
    await tick();
    await tick();

    stop();
    expect(handled).toEqual([1, 2]);
    expect(reported).toEqual([1]);
  });

  it('keeps watcher scheduling alive when async onError rejects', async () => {
    const source = shallowRef(0);
    const handled: number[] = [];
    const reported: number[] = [];

    const stop = watchSerialLatest(source, async value => {
      handled.push(value);
      if (value === 1) throw new Error('handler failed');
    }, {
      onError: async (_error, context) => {
        reported.push(context.value);
        throw new Error('async error reporter failed');
      },
    });

    source.value = 1;
    await tick();
    source.value = 2;
    await tick();
    await tick();

    stop();
    expect(handled).toEqual([1, 2]);
    expect(reported).toEqual([1]);
  });
});

describe('Hile topic adapters', () => {
  it('topicRef exposes the latest subscribed topic payload and stops cleanly', async () => {
    const app = new FakeApplication();
    const topic = await topicRef<number>(app, 'config:limit', { defaultValue: 1 });

    expect(topic.ref.value).toBe(1);
    expect(topic.ready.value).toBe(false);

    app.emitTopic('config:limit', 2);

    expect(topic.ref.value).toBe(2);
    expect(topic.ready.value).toBe(true);

    await topic.stop();
    app.emitTopic('config:limit', 3);

    expect(topic.ref.value).toBe(2);
  });

  it('topicRef preserves subscribe failures when onError throws', async () => {
    const app = new FakeApplication();
    app.failSubscribeTopic = 'config:limit';

    await expect(topicRef<number>(app, 'config:limit', {
      onError: () => {
        throw new Error('error reporter failed');
      },
    })).rejects.toThrow('subscribe failed: config:limit');
  });

  it('topicRef allows stop to be retried when unsubscribe fails', async () => {
    const app = new FakeApplication();
    const topic = await topicRef<number>(app, 'config:limit', { defaultValue: 1 });

    app.failUnsubscribeTopics.add('config:limit');
    await expect(topic.stop()).rejects.toThrow('unsubscribe failed: config:limit');

    app.failUnsubscribeTopics.delete('config:limit');
    await topic.stop();
    app.emitTopic('config:limit', 2);

    expect(app.unsubscribeAttempts).toEqual(['config:limit', 'config:limit']);
    expect(topic.ref.value).toBe(1);
  });

  it('publishRef publishes the initial value, serializes updates, and skips superseded pending values', async () => {
    const app = new FakeApplication();
    const source = shallowRef(1);
    const binding = await publishRef(app, 'runtime:limit', source);
    const publisher = app.publishers.get('runtime:limit')!;
    const firstUpdate = deferred();

    publisher.onUpdate = async value => {
      if (value === 2) await firstUpdate.promise;
    };

    expect(publisher.initial).toBe(1);

    source.value = 2;
    await tick();
    source.value = 3;
    source.value = 4;
    await tick();
    firstUpdate.resolve();
    await tick();
    await tick();

    await binding.stop();
    source.value = 5;
    await tick();

    expect(publisher.updates).toEqual([2, 4]);
    expect(publisher.unpublished).toBe(true);
  });

  it('publishRef waits for an in-flight update before unpublishing on stop', async () => {
    const app = new FakeApplication();
    const source = shallowRef(1);
    const binding = await publishRef(app, 'runtime:limit', source);
    const publisher = app.publishers.get('runtime:limit')!;
    const firstUpdate = deferred();

    publisher.onUpdate = async value => {
      if (value === 2) await firstUpdate.promise;
    };

    source.value = 2;
    await tick();

    const stopped = binding.stop();
    await tick();

    expect(publisher.updates).toEqual([2]);
    expect(publisher.unpublished).toBe(false);

    firstUpdate.resolve();
    await stopped;

    expect(publisher.unpublished).toBe(true);
  });

  it('publishRef keeps the binding alive when update onError throws', async () => {
    const app = new FakeApplication();
    const source = shallowRef(1);
    const binding = await publishRef(app, 'runtime:limit', source, {
      onError: () => {
        throw new Error('error reporter failed');
      },
    });
    const publisher = app.publishers.get('runtime:limit')!;

    publisher.onUpdate = async value => {
      if (value === 2) throw new Error('update failed');
    };

    source.value = 2;
    await tick();
    source.value = 3;
    await tick();

    await binding.stop();

    expect(publisher.updates).toEqual([2, 3]);
    expect(binding.error.value).toBeUndefined();
  });

  it('publishRef allows stop to retry unpublish after a failure', async () => {
    const app = new FakeApplication();
    const source = shallowRef(1);
    const binding = await publishRef(app, 'runtime:limit', source);
    const publisher = app.publishers.get('runtime:limit')!;

    publisher.failUnpublish = true;
    await expect(binding.stop()).rejects.toThrow('unpublish failed');

    publisher.failUnpublish = false;
    await binding.stop();
    source.value = 2;
    await tick();

    expect(publisher.unpublishAttempts).toBe(2);
    expect(publisher.unpublished).toBe(true);
    expect(publisher.updates).toEqual([]);
  });
});

describe('Hile config and reloader adapters', () => {
  it('reactiveConfig emits defaults only after required topic values are present', async () => {
    type RuntimeConfig = {
      mysql: { host: string };
      redis: { host: string };
      flags: Record<string, boolean>;
    };

    const app = new FakeApplication();
    const config = await reactiveConfig<RuntimeConfig>(app, {
      topics: {
        mysql: 'config:mysql',
        redis: 'config:redis',
        flags: 'config:flags',
      },
      required: ['mysql', 'redis'],
      defaults: { flags: {} },
    });

    expect(config.ready.value).toBe(false);
    expect(config.current.value).toBeUndefined();

    app.emitTopic('config:mysql', { host: 'db' });
    await tick();
    expect(config.current.value).toBeUndefined();

    app.emitTopic('config:redis', { host: 'cache' });
    await tick();

    expect(config.ready.value).toBe(true);
    expect(config.current.value).toEqual({
      mysql: { host: 'db' },
      redis: { host: 'cache' },
      flags: {},
    });

    await config.stop();
    app.emitTopic('config:mysql', { host: 'other' });
    await tick();

    expect(config.current.value?.mysql).toEqual({ host: 'db' });
  });

  it('reactiveConfig cleans up prior subscriptions and reports the failed topic when subscribe fails', async () => {
    type RuntimeConfig = {
      mysql: { host: string };
      redis: { host: string };
    };

    const app = new FakeApplication();
    app.failSubscribeTopic = 'config:redis';
    const errors: unknown[] = [];

    await expect(reactiveConfig<RuntimeConfig>(app, {
      topics: {
        mysql: 'config:mysql',
        redis: 'config:redis',
      },
      required: ['mysql', 'redis'],
      onError: (_error, context) => errors.push(context),
    })).rejects.toThrow('subscribe failed: config:redis');

    expect(app.unsubscribedTopics).toEqual(['config:mysql']);
    expect(errors).toEqual([
      { stage: 'subscribe', key: 'redis', topic: 'config:redis' },
    ]);
  });

  it('reactiveConfig preserves the subscribe failure when cleanup also fails', async () => {
    type RuntimeConfig = {
      mysql: { host: string };
      redis: { host: string };
    };

    const app = new FakeApplication();
    app.failSubscribeTopic = 'config:redis';
    app.failUnsubscribeTopics.add('config:mysql');
    const errors: unknown[] = [];

    await expect(reactiveConfig<RuntimeConfig>(app, {
      topics: {
        mysql: 'config:mysql',
        redis: 'config:redis',
      },
      required: ['mysql', 'redis'],
      onError: (_error, context) => errors.push(context),
    })).rejects.toThrow('subscribe failed: config:redis');

    expect(app.unsubscribeAttempts).toEqual(['config:mysql']);
    expect(errors).toEqual([
      { stage: 'unsubscribe', key: 'mysql', topic: 'config:mysql' },
      { stage: 'subscribe', key: 'redis', topic: 'config:redis' },
    ]);
  });

  it('reactiveConfig stop attempts all unsubscribers and can retry cleanup failures', async () => {
    type RuntimeConfig = {
      mysql: { host: string };
      redis: { host: string };
    };

    const app = new FakeApplication();
    const config = await reactiveConfig<RuntimeConfig>(app, {
      topics: {
        mysql: 'config:mysql',
        redis: 'config:redis',
      },
      required: ['mysql', 'redis'],
    });
    app.failUnsubscribeTopics.add('config:mysql');

    await expect(config.stop()).rejects.toThrow('unsubscribe failed: config:mysql');
    expect(() => app.emitTopic('config:mysql', { host: 'late' })).not.toThrow();

    app.failUnsubscribeTopics.delete('config:mysql');
    await config.stop();

    expect(app.unsubscribeAttempts).toEqual(['config:mysql', 'config:redis', 'config:mysql']);
    expect(config.current.value).toBeUndefined();
  });

  it('reactiveReloader exposes current runtime and state refs', async () => {
    const states: string[] = [];
    const runtime = reactiveReloader<number, { value: number }>({
      create: async value => ({ value }),
      onStateChange: state => states.push(state.status),
    });

    expect(runtime.state.value).toEqual({
      status: 'idle',
      hasCurrent: false,
      hasPending: false,
    });
    expect(runtime.current.value).toBeUndefined();

    await runtime.update(7);

    expect(runtime.current.value).toEqual({ value: 7 });
    expect(runtime.state.value).toEqual({
      status: 'idle',
      hasCurrent: true,
      hasPending: false,
    });
    expect(states).toContain('reloading');

    await runtime.stop();

    expect(runtime.current.value).toBeUndefined();
    expect(runtime.state.value.status).toBe('stopped');
  });

  it('reactiveReloader reflects pending updates while a reload is already running', async () => {
    const releaseFirst = deferred();
    const runtime = reactiveReloader<number, { value: number }>({
      create: async value => {
        if (value === 1) await releaseFirst.promise;
        return { value };
      },
    });

    const first = runtime.update(1);
    await tick();

    expect(runtime.state.value.status).toBe('reloading');
    expect(runtime.state.value.hasPending).toBe(false);

    const second = runtime.update(2);
    await tick();

    expect(runtime.state.value.hasPending).toBe(true);

    releaseFirst.resolve();
    await first;
    await second;

    expect(runtime.current.value).toEqual({ value: 2 });
    expect(runtime.state.value.hasPending).toBe(false);
  });
});
