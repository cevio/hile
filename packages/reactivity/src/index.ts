import {
  computed,
  effectScope,
  readonly,
  shallowRef,
  watch,
  type Ref,
  type ShallowRef,
  type WatchOptions,
  type WatchSource,
} from '@vue/reactivity';
import {
  createConfigAggregator,
  createRuntimeReloader,
  type ConfigAggregatorErrorContext,
  type ConfigAggregatorOptions,
  type RuntimeReloader,
  type RuntimeReloaderErrorContext,
  type RuntimeReloaderOptions,
  type RuntimeReloaderState,
} from '@hile/reloader';

export {
  computed,
  effectScope,
  readonly,
  shallowRef,
  watch,
};

type MaybePromise<T> = T | Promise<T>;
type ConfigKey<T extends object> = Extract<keyof T, string>;
type StopHandle = () => void;

export type ReadonlyRef<T> = Readonly<Ref<T>>;

export type ReactiveWatchSource<T> = WatchSource<T> | ReadonlyRef<T>;

function readonlyRef<T>(ref: ShallowRef<T>): ReadonlyRef<T> {
  return readonly(ref) as unknown as ReadonlyRef<T>;
}

export type AsyncWatchContext<T> = {
  oldValue: T | undefined;
  signal: AbortSignal;
  isCurrent(): boolean;
};

export type AsyncWatchErrorContext<T> = {
  value: T;
  oldValue: T | undefined;
};

export type AsyncWatchOptions<T> = WatchOptions & {
  onError?: (error: unknown, context: AsyncWatchErrorContext<T>) => void;
};

export type AsyncWatchHandler<T> = (
  value: T,
  context: AsyncWatchContext<T>,
) => MaybePromise<void>;

function watchOptions<T>(options: AsyncWatchOptions<T>) {
  const { onError: _onError, once: _once, ...rest } = options;
  return rest;
}

function safeCall(callback: (() => MaybePromise<void>) | undefined) {
  try {
    void Promise.resolve(callback?.()).catch(() => {
      // User async callbacks must not create unhandled rejections.
    });
  } catch {
    // User callbacks must not break watcher or lifecycle cleanup.
  }
}

function reportAsyncWatchError<T>(
  error: unknown,
  value: T,
  oldValue: T | undefined,
  options: AsyncWatchOptions<T>,
) {
  safeCall(() => options.onError?.(error, { value, oldValue }));
}

export function watchLatest<T>(
  source: ReactiveWatchSource<T>,
  handler: AsyncWatchHandler<T>,
  options: AsyncWatchOptions<T> = {},
): StopHandle {
  const once = options.once === true;
  let version = 0;
  let stopped = false;
  let onceConsumed = false;
  let activeOnceController: AbortController | undefined;
  let stopWatch: StopHandle | undefined;
  let stopWatchRequested = false;

  const stopWatcher = () => {
    if (stopWatch) {
      stopWatch();
      return;
    }
    stopWatchRequested = true;
  };

  const stop = () => {
    stopped = true;
    activeOnceController?.abort();
    stopWatcher();
  };

  stopWatch = watch(source, (value, oldValue, onCleanup) => {
    if (stopped || (once && onceConsumed)) return;
    if (once) {
      onceConsumed = true;
      stopWatcher();
    }

    const runVersion = ++version;
    const controller = new AbortController();

    if (once) {
      activeOnceController = controller;
    } else {
      onCleanup(() => {
        controller.abort();
      });
    }

    void Promise.resolve().then(() => {
      if (stopped || runVersion !== version || controller.signal.aborted) return;
      return handler(value, {
        oldValue,
        signal: controller.signal,
        isCurrent: () => !stopped && runVersion === version && !controller.signal.aborted,
      });
    }).catch(error => {
      if (!stopped && runVersion === version && !controller.signal.aborted) {
        reportAsyncWatchError(error, value, oldValue, options);
      }
    }).finally(() => {
      if (activeOnceController === controller) {
        activeOnceController = undefined;
      }
    });
  }, watchOptions(options));

  if (stopWatchRequested) stopWatch();
  return stop;
}

export function watchSerialLatest<T>(
  source: ReactiveWatchSource<T>,
  handler: AsyncWatchHandler<T>,
  options: AsyncWatchOptions<T> = {},
): StopHandle {
  const once = options.once === true;
  let stopped = false;
  let onceConsumed = false;
  let running = false;
  let pending: AsyncWatchErrorContext<T> | undefined;
  let activeController: AbortController | undefined;
  let stopWatch: StopHandle | undefined;
  let stopWatchRequested = false;

  const stopWatcher = () => {
    if (stopWatch) {
      stopWatch();
      return;
    }
    stopWatchRequested = true;
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (pending && !stopped) {
        const item = pending;
        pending = undefined;
        const controller = new AbortController();
        activeController = controller;

        try {
          await handler(item.value, {
            oldValue: item.oldValue,
            signal: controller.signal,
            isCurrent: () => !pending && activeController === controller && !controller.signal.aborted,
          });
        } catch (error) {
          if (!controller.signal.aborted) {
            reportAsyncWatchError(error, item.value, item.oldValue, options);
          }
        } finally {
          if (activeController === controller) {
            activeController = undefined;
          }
        }
      }
    } finally {
      running = false;
      if (pending && !stopped) {
        void pump();
      }
    }
  };

  stopWatch = watch(source, (value, oldValue) => {
    if (stopped || (once && onceConsumed)) return;
    if (once) {
      onceConsumed = true;
      stopWatcher();
    }
    pending = { value, oldValue };
    void pump();
  }, watchOptions(options));

  if (stopWatchRequested) stopWatch();

  return () => {
    stopped = true;
    pending = undefined;
    activeController?.abort();
    stopWatch?.();
  };
}

export function watchQueue<T>(
  source: ReactiveWatchSource<T>,
  handler: AsyncWatchHandler<T>,
  options: AsyncWatchOptions<T> = {},
): StopHandle {
  const once = options.once === true;
  let stopped = false;
  let onceConsumed = false;
  let running = false;
  const queue: AsyncWatchErrorContext<T>[] = [];
  let activeController: AbortController | undefined;
  let stopWatch: StopHandle | undefined;
  let stopWatchRequested = false;

  const stopWatcher = () => {
    if (stopWatch) {
      stopWatch();
      return;
    }
    stopWatchRequested = true;
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && !stopped) {
        const item = queue.shift()!;
        const controller = new AbortController();
        activeController = controller;

        try {
          await handler(item.value, {
            oldValue: item.oldValue,
            signal: controller.signal,
            isCurrent: () => activeController === controller && !controller.signal.aborted,
          });
        } catch (error) {
          if (!controller.signal.aborted) {
            reportAsyncWatchError(error, item.value, item.oldValue, options);
          }
        } finally {
          if (activeController === controller) {
            activeController = undefined;
          }
        }
      }
    } finally {
      running = false;
      if (queue.length > 0 && !stopped) {
        void pump();
      }
    }
  };

  stopWatch = watch(source, (value, oldValue) => {
    if (stopped || (once && onceConsumed)) return;
    if (once) {
      onceConsumed = true;
      stopWatcher();
    }
    queue.push({ value, oldValue });
    void pump();
  }, watchOptions(options));

  if (stopWatchRequested) stopWatch();

  return () => {
    stopped = true;
    queue.length = 0;
    activeController?.abort();
    stopWatch?.();
  };
}

export type TopicSubscriber = {
  subscribe<T = unknown>(
    topic: string,
    callback: (value: T) => MaybePromise<void>,
  ): Promise<() => MaybePromise<void>>;
};

export type TopicPublisher<T> = {
  update(value: T): MaybePromise<unknown>;
  unpublish(): MaybePromise<unknown>;
};

export type TopicPublishingApplication = {
  publish<T = unknown>(topic: string, value: T): Promise<TopicPublisher<T>>;
};

export type TopicRefOptions<T> = {
  defaultValue?: T;
  onError?: (error: unknown) => void;
};

export type TopicRefResult<T> = {
  ref: ReadonlyRef<T | undefined>;
  ready: ReadonlyRef<boolean>;
  error: ReadonlyRef<unknown | undefined>;
  stop(): Promise<void>;
};

export async function topicRef<T>(
  app: TopicSubscriber,
  topic: string,
  options: TopicRefOptions<T> = {},
): Promise<TopicRefResult<T>> {
  const value = shallowRef<T | undefined>(options.defaultValue);
  const ready = shallowRef(false);
  const error = shallowRef<unknown>();
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  let unsubscribe: () => MaybePromise<void>;
  try {
    unsubscribe = await app.subscribe<T>(topic, next => {
      value.value = next;
      ready.value = true;
      error.value = undefined;
    });
  } catch (err) {
    error.value = err;
    safeCall(() => options.onError?.(err));
    throw err;
  }

  return {
    ref: readonlyRef(value),
    ready: readonlyRef(ready),
    error: readonlyRef(error),
    async stop() {
      if (stopped) return;
      if (stopPromise) return stopPromise;
      stopPromise = Promise.resolve()
        .then(() => unsubscribe())
        .then(() => {
          stopped = true;
        })
        .catch(err => {
          stopPromise = undefined;
          throw err;
        });
      return stopPromise;
    },
  };
}

export type PublishRefOptions<T> = {
  onError?: (error: unknown, context: AsyncWatchErrorContext<T>) => void;
};

export type PublishRefResult = {
  error: ReadonlyRef<unknown | undefined>;
  stop(): Promise<void>;
};

export async function publishRef<T>(
  app: TopicPublishingApplication,
  topic: string,
  source: Ref<T>,
  options: PublishRefOptions<T> = {},
): Promise<PublishRefResult> {
  const error = shallowRef<unknown>();
  const publisher = await app.publish(topic, source.value);
  let stopped = false;
  let unpublished = false;
  let stopPromise: Promise<void> | undefined;
  let running = false;
  let hasPending = false;
  let pendingValue: T | undefined;
  let pendingOldValue: T | undefined;
  const idleWaiters = new Set<() => void>();

  const resolveIdle = () => {
    if (running) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };

  const waitForIdle = () => {
    if (!running) return Promise.resolve();
    return new Promise<void>(resolve => {
      idleWaiters.add(resolve);
    });
  };

  const pump = async () => {
    if (running) return;
    running = true;
    try {
      while (hasPending && !stopped) {
        const value = pendingValue as T;
        const oldValue = pendingOldValue;
        hasPending = false;
        pendingValue = undefined;
        pendingOldValue = undefined;

        try {
          await publisher.update(value);
          error.value = undefined;
        } catch (err) {
          error.value = err;
          safeCall(() => options.onError?.(err, { value, oldValue }));
        }
      }
    } finally {
      running = false;
      if (hasPending && !stopped) {
        void pump();
      } else {
        resolveIdle();
      }
    }
  };

  const stopWatch = watch(source, (value, oldValue) => {
    hasPending = true;
    pendingValue = value;
    pendingOldValue = oldValue;
    void pump();
  });

  return {
    error: readonlyRef(error),
    async stop() {
      if (unpublished) return;
      if (stopPromise) return stopPromise;
      stopPromise = Promise.resolve()
        .then(async () => {
          if (!stopped) {
            stopped = true;
            stopWatch();
            hasPending = false;
            pendingValue = undefined;
            pendingOldValue = undefined;
            await waitForIdle();
          }
          await publisher.unpublish();
          unpublished = true;
        })
        .catch(err => {
          stopPromise = undefined;
          throw err;
        });
      return stopPromise;
    },
  };
}

export type ReactiveConfigTopics<T extends object> = Partial<Record<ConfigKey<T>, string>>;

export type ReactiveConfigLifecycleErrorContext<T extends object> = {
  stage: 'subscribe' | 'unsubscribe';
  topic: string;
  key: ConfigKey<T>;
};

export type ReactiveConfigOptions<T extends object> =
  Omit<ConfigAggregatorOptions<T>, 'onError'> & {
    topics: ReactiveConfigTopics<T>;
    onError?: (
      error: unknown,
      context: ConfigAggregatorErrorContext<T> | ReactiveConfigLifecycleErrorContext<T>,
    ) => void;
  };

export type ReactiveConfigResult<T extends object> = {
  current: ReadonlyRef<T | undefined>;
  ready: ReadonlyRef<boolean>;
  error: ReadonlyRef<unknown | undefined>;
  stop(): Promise<void>;
};

export async function reactiveConfig<T extends object>(
  app: TopicSubscriber,
  options: ReactiveConfigOptions<T>,
): Promise<ReactiveConfigResult<T>> {
  const { topics, onError, ...aggregatorOptions } = options;
  const current = shallowRef<T>();
  const ready = shallowRef(false);
  const error = shallowRef<unknown>();
  const subscriptions: Array<{
    key: ConfigKey<T>;
    topic: string;
    unsubscribe: () => MaybePromise<void>;
  }> = [];
  let stopped = false;
  let stopPromise: Promise<void> | undefined;
  let subscribing: { key: ConfigKey<T>; topic: string } | undefined;

  const aggregator = createConfigAggregator<T>({
    ...aggregatorOptions,
    onError: (err, context) => {
      error.value = err;
      safeCall(() => onError?.(err, context));
    },
  });

  aggregator.onChange(config => {
    current.value = config;
    ready.value = true;
    error.value = undefined;
  });

  const cleanup = async () => {
    const cleanupErrors: unknown[] = [];
    const failedSubscriptions: typeof subscriptions = [];

    for (const subscription of subscriptions.splice(0)) {
      try {
        await subscription.unsubscribe();
      } catch (err) {
        failedSubscriptions.push(subscription);
        cleanupErrors.push(err);
        error.value = err;
        safeCall(() => onError?.(err, {
          stage: 'unsubscribe',
          key: subscription.key,
          topic: subscription.topic,
        }));
      }
    }

    subscriptions.push(...failedSubscriptions);
    aggregator.dispose();

    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'reactiveConfig unsubscribe failed');
    }
  };

  try {
    for (const [key, topic] of Object.entries(topics) as Array<[ConfigKey<T>, string | undefined]>) {
      if (!topic) continue;
      subscribing = { key, topic };
      const unsubscribe = await app.subscribe(topic, value => {
        if (stopped) return;
        aggregator.set(key, value as T[typeof key]);
      });
      subscriptions.push({ key, topic, unsubscribe });
      subscribing = undefined;
    }
    await aggregator.flush();
  } catch (err) {
    error.value = err;
    stopped = true;
    try {
      await cleanup();
    } catch {
      // Preserve the original subscribe/flush failure while still best-effort cleaning subscriptions.
    }
    if (subscribing) {
      const context = subscribing;
      safeCall(() => onError?.(err, { stage: 'subscribe', key: context.key, topic: context.topic }));
    }
    throw err;
  }

  return {
    current: readonlyRef(current),
    ready: readonlyRef(ready),
    error: readonlyRef(error),
    async stop() {
      stopped = true;
      if (subscriptions.length === 0) return;
      if (stopPromise) return stopPromise;
      stopPromise = cleanup().catch(err => {
        stopPromise = undefined;
        throw err;
      });
      return stopPromise;
    },
  };
}

export type ReactiveReloaderResult<Input, Runtime> = {
  current: ReadonlyRef<Runtime | undefined>;
  state: ReadonlyRef<RuntimeReloaderState>;
  error: ReadonlyRef<unknown | undefined>;
  update(input: Input): Promise<void>;
  stop(): Promise<void>;
  whenIdle(): Promise<void>;
  raw: RuntimeReloader<Input, Runtime>;
};

export function reactiveReloader<Input, Runtime>(
  options: RuntimeReloaderOptions<Input, Runtime>,
): ReactiveReloaderResult<Input, Runtime> {
  const current = shallowRef<Runtime>();
  const state = shallowRef<RuntimeReloaderState>({
    status: 'idle',
    hasCurrent: false,
    hasPending: false,
  });
  const error = shallowRef<unknown>();
  let inner: RuntimeReloader<Input, Runtime>;

  const sync = (nextState?: RuntimeReloaderState) => {
    state.value = nextState ?? inner.state();
    current.value = inner.current();
  };

  inner = createRuntimeReloader({
    ...options,
    onError: (
      err: unknown,
      context: RuntimeReloaderErrorContext<Input, Runtime>,
    ) => {
      error.value = err;
      safeCall(() => options.onError?.(err, context));
    },
    onStateChange: nextState => {
      sync(nextState);
      safeCall(() => options.onStateChange?.(nextState));
    },
  });
  sync();

  return {
    current: readonlyRef(current),
    state: readonlyRef(state),
    error: readonlyRef(error),
    async update(input: Input) {
      try {
        await inner.update(input);
        error.value = undefined;
        sync();
      } catch (err) {
        error.value = err;
        sync();
        throw err;
      }
    },
    async stop() {
      await inner.stop();
      sync();
    },
    whenIdle() {
      return inner.whenIdle();
    },
    raw: inner,
  };
}
