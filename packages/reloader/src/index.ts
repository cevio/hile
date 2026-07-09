type MaybePromise<T> = T | Promise<T>;
type ConfigKey<T extends object> = Extract<keyof T, string>;
type IdleWaiter = {
  resolve: () => void;
  reject: (error: unknown) => void;
};

type CompletedUpdateWaiter = {
  waiter: IdleWaiter;
  error?: unknown;
};

type ReloadResult = {
  applied: boolean;
  error?: unknown;
};

export type RuntimeReloaderStatus = 'idle' | 'scheduled' | 'reloading' | 'stopping' | 'stopped';

export type RuntimeReloaderErrorStage = 'create' | 'dispose';

export type RuntimeReloaderErrorContext<Input, Runtime> = {
  stage: RuntimeReloaderErrorStage;
  input?: Input;
  runtime?: Runtime;
  reason?: 'reload' | 'stop';
};

export type RuntimeReloaderCompareErrorContext<Input> = {
  previous?: Input;
  next: Input;
};

export type RuntimeReloaderCreateContext<Input, Runtime> = {
  signal: AbortSignal;
  previous?: Runtime;
  previousInput?: Input;
  attempt: number;
};

export type RuntimeReloaderDisposeContext<Input> = {
  signal: AbortSignal;
  input: Input;
  reason: 'reload' | 'stop';
};

export type RuntimeReloaderState = {
  status: RuntimeReloaderStatus;
  hasCurrent: boolean;
  hasPending: boolean;
};

export type RuntimeReloaderOptions<Input, Runtime> = {
  create: (
    input: Input,
    context: RuntimeReloaderCreateContext<Input, Runtime>,
  ) => MaybePromise<Runtime>;
  dispose?: (
    runtime: Runtime,
    context: RuntimeReloaderDisposeContext<Input>,
  ) => MaybePromise<void>;
  debounceMs?: number;
  createTimeoutMs?: number;
  disposeTimeoutMs?: number;
  equals?: (previous: Input, next: Input) => boolean;
  signature?: (input: Input) => unknown;
  normalize?: (input: Input) => unknown;
  onError?: (
    error: unknown,
    context: RuntimeReloaderErrorContext<Input, Runtime>,
  ) => void;
  onCompareError?: (
    error: unknown,
    context: RuntimeReloaderCompareErrorContext<Input>,
  ) => void;
  onStateChange?: (state: RuntimeReloaderState) => void;
};

export type RuntimeReloader<Input, Runtime> = {
  update(input: Input): Promise<void>;
  stop(): Promise<void>;
  current(): Runtime | undefined;
  whenIdle(): Promise<void>;
  state(): RuntimeReloaderState;
};

export type ConfigAggregatorCompareErrorContext<T extends object> = {
  previous?: T;
  next: T;
};

export type ConfigAggregatorErrorContext<T extends object> = {
  stage: 'listener';
  config: T;
};

export type ConfigAggregatorOptions<T extends object = Record<string, unknown>> = {
  required?: readonly ConfigKey<T>[];
  defaults?: Partial<T>;
  debounceMs?: number;
  equals?: (previous: T, next: T) => boolean;
  signature?: (config: T) => unknown;
  normalize?: (config: T) => unknown;
  onCompareError?: (
    error: unknown,
    context: ConfigAggregatorCompareErrorContext<T>,
  ) => void;
  onError?: (
    error: unknown,
    context: ConfigAggregatorErrorContext<T>,
  ) => void;
};

export type ConfigAggregator<T extends object = Record<string, unknown>> = {
  set<K extends ConfigKey<T>>(key: K, value: T[K]): void;
  unset(key: ConfigKey<T>): void;
  flush(): Promise<void>;
  onChange(listener: (config: T) => MaybePromise<void>): () => void;
  snapshot(): Partial<T>;
  isReady(): boolean;
  dispose(): void;
};

const DEFAULT_CREATE_TIMEOUT_MS = 30_000;
const DEFAULT_DISPOSE_TIMEOUT_MS = 10_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableSignature(value: unknown, seen = new WeakSet<object>()): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';

  const type = typeof value;
  if (type === 'string') return `string:${JSON.stringify(value)}`;
  if (type === 'number') {
    if (Number.isNaN(value)) return 'number:NaN';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${String(value)}`;
  }
  if (type === 'boolean') return `boolean:${String(value)}`;
  if (type === 'bigint') return `bigint:${String(value)}`;
  if (type === 'symbol' || type === 'function') {
    throw new TypeError(`stable signature does not support ${type} values`);
  }
  if (typeof value !== 'object') return `${type}:${String(value)}`;

  if (seen.has(value)) {
    throw new TypeError('stable signature does not support circular values');
  }
  seen.add(value);

  try {
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new TypeError('stable signature does not support invalid Date values');
      }
      return `date:${value.toISOString()}`;
    }

    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        if (!(i in value)) {
          throw new TypeError('stable signature does not support sparse arrays');
        }
        items.push(stableSignature(value[i], seen));
      }
      return `array:[${items.join(',')}]`;
    }

    if (!isPlainObject(value)) {
      throw new TypeError(`stable signature does not support ${Object.prototype.toString.call(value)} values`);
    }

    const keys = Object.keys(value).sort();
    return `object:{${keys.map(key => `${JSON.stringify(key)}:${stableSignature(value[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function safeCall(callback: (() => void) | undefined) {
  if (!callback) return;
  try {
    callback();
  } catch {
    // User callbacks must not break scheduler cleanup.
  }
}

function safeAsync(callback: (() => MaybePromise<void>) | undefined) {
  if (!callback) return;
  Promise.resolve()
    .then(callback)
    .catch(() => {
      // Late cleanup callbacks are best-effort and must not create unhandled rejections.
    });
}

type TimeoutOptions<T> = {
  timeoutMs: number;
  timeoutMessage: string;
  abortMessage: string;
  controller?: AbortController;
  onLateResolve?: (value: T) => MaybePromise<void>;
};

async function withTimeout<T>(
  operation: (signal: AbortSignal) => MaybePromise<T>,
  options: TimeoutOptions<T>,
): Promise<T> {
  const controller = options.controller ?? new AbortController();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let shouldHandleLateResolve = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      controller.signal.removeEventListener('abort', onAbort);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const fail = (error: Error, abort: boolean) => {
      if (settled) return;
      shouldHandleLateResolve = true;
      settle(() => {
        if (abort && !controller.signal.aborted) controller.abort();
        reject(error);
      });
    };
    const onAbort = () => {
      fail(new Error(options.abortMessage), false);
    };

    if (controller.signal.aborted) {
      fail(new Error(options.abortMessage), false);
      return;
    }

    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (options.timeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(options.timeoutMessage), true);
      }, options.timeoutMs);
    }

    Promise.resolve()
      .then(() => operation(controller.signal))
      .then(
        value => {
          if (settled) {
            if (shouldHandleLateResolve) {
              safeAsync(() => options.onLateResolve?.(value));
            }
            return;
          }
          settle(() => resolve(value));
        },
        error => {
          if (settled) return;
          settle(() => reject(error));
        },
      );
  });
}

class RuntimeReloaderImpl<Input, Runtime> implements RuntimeReloader<Input, Runtime> {
  private status: RuntimeReloaderStatus = 'idle';
  private timer?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private running = false;
  private stopping = false;
  private stopped = false;
  private hasPending = false;
  private pendingInput?: Input;
  private hasCurrentRuntime = false;
  private currentRuntime?: Runtime;
  private currentInput?: Input;
  private hasCurrentSignature = false;
  private currentSignature?: string;
  private idleWaiters = new Set<IdleWaiter>();
  private pendingUpdateWaiters = new Set<IdleWaiter>();
  private completedUpdateWaiters: CompletedUpdateWaiter[] = [];
  private runningWaiters = new Set<() => void>();
  private attempt = 0;
  private activeCreateController?: AbortController;

  constructor(private readonly options: RuntimeReloaderOptions<Input, Runtime>) {}

  public update(input: Input): Promise<void> {
    if (this.stopped || this.stopping) {
      return Promise.reject(new Error('RuntimeReloader has been stopped'));
    }
    let waiter!: IdleWaiter;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
    });
    this.pendingInput = input;
    this.pendingUpdateWaiters.add(waiter);
    this.setHasPending(true);
    this.schedule();
    return promise;
  }

  public async stop(): Promise<void> {
    if (this.stopped) return;

    this.stopping = true;
    this.activeCreateController?.abort();
    this.clearScheduled();
    this.completeUpdateWaiters(this.takePendingUpdateWaiters());
    this.pendingInput = undefined;
    this.setHasPending(false);
    this.setStatus('stopping');

    await this.waitForRunningToFinish();

    if (this.hasCurrentRuntime) {
      await this.disposeRuntime(this.currentRuntime as Runtime, this.currentInput as Input, 'stop');
    }

    this.currentRuntime = undefined;
    this.currentInput = undefined;
    this.currentSignature = undefined;
    this.hasCurrentRuntime = false;
    this.hasCurrentSignature = false;
    this.stopped = true;
    this.stopping = false;
    this.setStatus('stopped');
    this.resolveIdleIfReady();
  }

  public current(): Runtime | undefined {
    return this.hasCurrentRuntime ? this.currentRuntime : undefined;
  }

  public whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.idleWaiters.add({ resolve, reject });
    });
  }

  public state(): RuntimeReloaderState {
    return {
      status: this.status,
      hasCurrent: this.hasCurrentRuntime,
      hasPending: this.hasPending,
    };
  }

  private schedule() {
    if (this.running || this.stopping || this.stopped) return;

    const debounceMs = this.options.debounceMs ?? 0;
    if (this.scheduled) {
      if (debounceMs > 0) this.startDebounceTimer(debounceMs);
      return;
    }

    this.scheduled = true;
    this.setStatus('scheduled');

    if (debounceMs > 0) {
      this.startDebounceTimer(debounceMs);
      return;
    }

    queueMicrotask(() => {
      if (!this.scheduled) return;
      this.scheduled = false;
      void this.runLoop();
    });
  }

  private clearScheduled() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduled = false;
  }

  private startDebounceTimer(debounceMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduled = false;
      void this.runLoop();
    }, debounceMs);
  }

  private async runLoop() {
    if (this.running || this.stopping || this.stopped) return;
    this.running = true;
    this.setStatus('reloading');
    let reloadError: unknown;

    try {
      while (this.hasPending && !this.stopping && !this.stopped) {
        const input = this.pendingInput as Input;
        const updateWaiters = this.takePendingUpdateWaiters();
        this.pendingInput = undefined;
        this.setHasPending(false);

        if (this.shouldSkip(input)) {
          this.completeUpdateWaiters(updateWaiters);
          continue;
        }
        const result = await this.reload(input);
        if (result.applied) {
          reloadError = undefined;
          this.completeUpdateWaiters(updateWaiters);
        } else if (result.error) {
          reloadError = result.error;
          this.completeUpdateWaiters(updateWaiters, result.error);
        } else {
          this.completeUpdateWaiters(updateWaiters);
        }
      }
    } finally {
      this.running = false;
      this.resolveRunningWaiters();

      if (this.hasPending && !this.stopping && !this.stopped) {
        this.schedule();
      } else if (!this.stopping && !this.stopped) {
        this.setStatus('idle');
      }
      this.resolveIdleIfReady(reloadError);
    }
  }

  private async reload(input: Input): Promise<ReloadResult> {
    const previousRuntime = this.currentRuntime;
    const previousInput = this.currentInput;
    const hadPrevious = this.hasCurrentRuntime;

    const controller = new AbortController();
    this.activeCreateController = controller;
    let runtime: Runtime;
    try {
      runtime = await withTimeout(
        signal => this.options.create(input, {
          signal,
          previous: previousRuntime,
          previousInput,
          attempt: ++this.attempt,
        }),
        {
          timeoutMs: this.options.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
          timeoutMessage: 'RuntimeReloader create timed out',
          abortMessage: 'RuntimeReloader create aborted',
          controller,
          onLateResolve: lateRuntime => this.disposeRuntime(
            lateRuntime,
            input,
            this.stopping || this.stopped ? 'stop' : 'reload',
          ),
        },
      );
    } catch (error) {
      if (!(this.stopping && controller.signal.aborted)) {
        this.reportError(error, { stage: 'create', input });
        return { applied: false, error };
      }
      return { applied: false };
    } finally {
      if (this.activeCreateController === controller) {
        this.activeCreateController = undefined;
      }
    }

    this.currentRuntime = runtime;
    this.currentInput = input;
    this.hasCurrentRuntime = true;
    this.storeCurrentSignature(input);

    if (hadPrevious && this.options.dispose) {
      await this.disposeRuntime(previousRuntime as Runtime, previousInput as Input, 'reload');
    }
    return { applied: true };
  }

  private async disposeRuntime(runtime: Runtime, input: Input, reason: 'reload' | 'stop') {
    if (!this.options.dispose) return;

    try {
      await withTimeout(
        signal => this.options.dispose!(runtime, { signal, input, reason }),
        {
          timeoutMs: this.options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS,
          timeoutMessage: 'RuntimeReloader dispose timed out',
          abortMessage: 'RuntimeReloader dispose aborted',
        },
      );
    } catch (error) {
      this.reportError(error, { stage: 'dispose', input, runtime, reason });
    }
  }

  private shouldSkip(next: Input): boolean {
    if (!this.hasCurrentRuntime) return false;
    const previous = this.currentInput as Input;

    try {
      if (this.options.equals) return this.options.equals(previous, next);
      if (!this.options.signature && !this.options.normalize && isPrimitiveLike(previous) && Object.is(previous, next)) {
        return true;
      }
      if (!this.hasCurrentSignature) return false;
      return this.currentSignature === this.signatureFor(next);
    } catch (error) {
      this.reportCompareError(error, { previous, next });
      return false;
    }
  }

  private signatureFor(input: Input): string {
    if (this.options.signature) return stableSignature(this.options.signature(input));
    if (this.options.normalize) return stableSignature(this.options.normalize(input));
    return stableSignature(input);
  }

  private storeCurrentSignature(input: Input) {
    try {
      this.currentSignature = this.signatureFor(input);
      this.hasCurrentSignature = true;
    } catch (error) {
      this.currentSignature = undefined;
      this.hasCurrentSignature = false;
      this.reportCompareError(error, { next: input });
    }
  }

  private reportError(error: unknown, context: RuntimeReloaderErrorContext<Input, Runtime>) {
    safeCall(() => this.options.onError?.(error, context));
  }

  private reportCompareError(error: unknown, context: RuntimeReloaderCompareErrorContext<Input>) {
    safeCall(() => this.options.onCompareError?.(error, context));
  }

  private setStatus(status: RuntimeReloaderStatus) {
    if (this.status === status) return;
    this.status = status;
    this.emitStateChange();
  }

  private setHasPending(hasPending: boolean) {
    if (this.hasPending === hasPending) return;
    this.hasPending = hasPending;
    this.emitStateChange();
  }

  private emitStateChange() {
    safeCall(() => this.options.onStateChange?.(this.state()));
  }

  private isIdle() {
    return !this.running && !this.scheduled && !this.hasPending && !this.stopping;
  }

  private resolveIdleIfReady(error?: unknown) {
    if (!this.isIdle()) return;
    this.settleCompletedUpdateWaiters();
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }

  private takePendingUpdateWaiters(): IdleWaiter[] {
    const waiters = [...this.pendingUpdateWaiters];
    this.pendingUpdateWaiters.clear();
    return waiters;
  }

  private completeUpdateWaiters(waiters: Iterable<IdleWaiter>, error?: unknown) {
    for (const waiter of waiters) {
      this.completedUpdateWaiters.push({ waiter, error });
    }
  }

  private settleCompletedUpdateWaiters() {
    const completed = [...this.completedUpdateWaiters];
    this.completedUpdateWaiters = [];
    for (const { waiter, error } of completed) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    }
  }

  private waitForRunningToFinish(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise(resolve => {
      this.runningWaiters.add(resolve);
    });
  }

  private resolveRunningWaiters() {
    const waiters = [...this.runningWaiters];
    this.runningWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

function isPrimitiveLike(value: unknown) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

class ConfigAggregatorImpl<T extends object> implements ConfigAggregator<T> {
  private readonly required: Set<string>;
  private readonly values = new Map<string, unknown>();
  private readonly present = new Set<string>();
  private readonly listeners = new Set<(config: T) => MaybePromise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private scheduled = false;
  private disposed = false;
  private emitQueue: Promise<void> = Promise.resolve();
  private hasEmitted = false;
  private lastConfig?: T;
  private hasLastSignature = false;
  private lastSignature?: string;

  constructor(private readonly options: ConfigAggregatorOptions<T>) {
    this.required = new Set(options.required ?? []);
  }

  public set<K extends ConfigKey<T>>(key: K, value: T[K]): void {
    this.assertActive();
    this.values.set(key, value);
    this.present.add(key);
    this.schedule();
  }

  public unset(key: ConfigKey<T>): void {
    this.assertActive();
    this.values.delete(key);
    this.present.delete(key);
    this.schedule();
  }

  public async flush(): Promise<void> {
    this.assertActive();
    this.clearScheduled();
    if (!this.isReady()) return;
    await this.enqueueEmit(true);
  }

  public onChange(listener: (config: T) => MaybePromise<void>): () => void {
    this.assertActive();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public snapshot(): Partial<T> {
    return this.buildConfig();
  }

  public isReady(): boolean {
    for (const key of this.required) {
      if (!this.present.has(key)) return false;
    }
    return true;
  }

  public dispose(): void {
    this.clearScheduled();
    this.listeners.clear();
    this.disposed = true;
  }

  private schedule() {
    if (this.disposed || !this.isReady()) return;

    const debounceMs = this.options.debounceMs ?? 0;
    if (this.scheduled) {
      if (debounceMs > 0) this.startDebounceTimer(debounceMs);
      return;
    }

    this.scheduled = true;

    if (debounceMs > 0) {
      this.startDebounceTimer(debounceMs);
      return;
    }

    queueMicrotask(() => {
      if (!this.scheduled || this.disposed) return;
      this.scheduled = false;
      void this.enqueueEmit(false);
    });
  }

  private clearScheduled() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.scheduled = false;
  }

  private startDebounceTimer(debounceMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.scheduled = false;
      void this.enqueueEmit(false);
    }, debounceMs);
  }

  private enqueueEmit(throwOnError: boolean): Promise<void> {
    const run = this.emitQueue.then(
      () => this.emitNow(throwOnError),
      () => this.emitNow(throwOnError),
    );
    this.emitQueue = run.catch(() => {
      // Keep later emits alive even when this emit reports a listener failure.
    });
    return run;
  }

  private async emitNow(throwOnError: boolean) {
    if (this.disposed || !this.isReady()) return;
    const config = this.buildConfig() as T;
    if (this.shouldSkip(config)) return;

    const errors: unknown[] = [];

    await Promise.all([...this.listeners].map(async listener => {
      try {
        await listener(config);
      } catch (error) {
        errors.push(error);
        this.reportError(error, { stage: 'listener', config });
      }
    }));

    if (errors.length > 0) {
      if (throwOnError) throw errors[0];
      return;
    }

    this.lastConfig = config;
    this.hasEmitted = true;
    this.storeLastSignature(config);
  }

  private buildConfig(): Partial<T> {
    const config: Record<string, unknown> = { ...(this.options.defaults ?? {}) };
    for (const [key, value] of this.values) {
      config[key] = value;
    }
    return config as Partial<T>;
  }

  private shouldSkip(next: T): boolean {
    if (!this.hasEmitted) return false;
    const previous = this.lastConfig as T;

    try {
      if (this.options.equals) return this.options.equals(previous, next);
      if (!this.hasLastSignature) return false;
      return this.lastSignature === this.signatureFor(next);
    } catch (error) {
      this.reportCompareError(error, { previous, next });
      return false;
    }
  }

  private signatureFor(config: T): string {
    if (this.options.signature) return stableSignature(this.options.signature(config));
    if (this.options.normalize) return stableSignature(this.options.normalize(config));
    return stableSignature(config);
  }

  private storeLastSignature(config: T) {
    try {
      this.lastSignature = this.signatureFor(config);
      this.hasLastSignature = true;
    } catch (error) {
      this.lastSignature = undefined;
      this.hasLastSignature = false;
      this.reportCompareError(error, { next: config });
    }
  }

  private reportCompareError(error: unknown, context: ConfigAggregatorCompareErrorContext<T>) {
    safeCall(() => this.options.onCompareError?.(error, context));
  }

  private reportError(error: unknown, context: ConfigAggregatorErrorContext<T>) {
    safeCall(() => this.options.onError?.(error, context));
  }

  private assertActive() {
    if (this.disposed) throw new Error('ConfigAggregator has been disposed');
  }
}

export function createRuntimeReloader<Input, Runtime>(
  options: RuntimeReloaderOptions<Input, Runtime>,
): RuntimeReloader<Input, Runtime> {
  return new RuntimeReloaderImpl(options);
}

export function createConfigAggregator<T extends object = Record<string, unknown>>(
  options: ConfigAggregatorOptions<T> = {},
): ConfigAggregator<T> {
  return new ConfigAggregatorImpl(options);
}
