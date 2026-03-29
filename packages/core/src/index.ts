import { AsyncLocalStorage } from 'node:async_hooks';

export type ServiceCutDownFunction = () => unknown | Promise<unknown>;
export type ServiceCutDownHandler = (fn: ServiceCutDownFunction) => void;
export type ServiceFunction<R> = (fn: ServiceCutDownHandler) => R | Promise<R>;
export type ServiceKey = string | symbol;

const sericeFlag = Symbol.for('service');

declare global {
  var HILE_GLOBAL_CONTAINER: Container;
}

export type ServiceLifecycleStage = 'init' | 'ready' | 'stopping' | 'stopped';

export interface ServiceRegisterProps<R> {
  fn: ServiceFunction<R>
  flag: typeof sericeFlag;
  key: ServiceKey;
}

export interface ContainerOptions {
  startTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export type ContainerEvent =
  | { type: 'service:init'; key: ServiceKey }
  | { type: 'service:ready'; key: ServiceKey; durationMs: number }
  | { type: 'service:error'; key: ServiceKey; error: any; durationMs: number }
  | { type: 'service:shutdown:start'; key: ServiceKey }
  | { type: 'service:shutdown:done'; key: ServiceKey; durationMs: number }
  | { type: 'service:shutdown:error'; key: ServiceKey; error: any }
  | { type: 'container:shutdown:start' }
  | { type: 'container:shutdown:done'; durationMs: number }
  | { type: 'container:error'; error: any };

interface Paddings<R = any> {
  status: -1 | 0 | 1;
  lifecycle: ServiceLifecycleStage;
  value: R;
  error?: any;
  queue: Set<{ resolve: (value: R) => void, reject: (error: any) => void }>;
  startedAt: number;
  endedAt?: number;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, message?: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message || `Operation timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 日志或调试时展示服务 key */
export function formatServiceKey(k: ServiceKey): string {
  return typeof k === 'string' ? k : String(k);
}

export class Container {
  private keyOrder = 0;
  private readonly keyOrdinal = new Map<ServiceKey, number>();
  private readonly registeredKeys = new Set<ServiceKey>();
  private readonly paddings = new Map<ServiceKey, Paddings>();

  private readonly dependencies = new Map<ServiceKey, Set<ServiceKey>>();
  private readonly dependents = new Map<ServiceKey, Set<ServiceKey>>();

  private readonly shutdownFunctions = new Map<ServiceKey, ServiceCutDownFunction[]>();
  private readonly shutdownQueues: ServiceKey[] = [];
  private readonly startupOrder: ServiceKey[] = [];

  private readonly listeners = new Set<(event: ContainerEvent) => void>();
  private readonly context = new AsyncLocalStorage<ServiceKey[]>();

  constructor(private readonly options: ContainerOptions = {}) { }

  private emit(event: ContainerEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  private nextOrdinal() {
    let o = ++this.keyOrder;
    if (o >= Number.MAX_SAFE_INTEGER) {
      o = this.keyOrder = 1;
    }
    return o;
  }

  private hasPath(from: ServiceKey, to: ServiceKey, visited = new Set<ServiceKey>()): boolean {
    if (from === to) return true;
    if (visited.has(from)) return false;
    visited.add(from);

    const deps = this.dependencies.get(from);
    if (!deps) return false;

    for (const next of deps) {
      if (this.hasPath(next, to, visited)) return true;
    }
    return false;
  }

  private trackDependency(parentKey: ServiceKey, childKey: ServiceKey) {
    if (parentKey === childKey) {
      throw new Error(`circular dependency detected: ${formatServiceKey(parentKey)} -> ${formatServiceKey(childKey)}`);
    }

    if (!this.dependencies.has(parentKey)) {
      this.dependencies.set(parentKey, new Set());
    }
    if (!this.dependents.has(childKey)) {
      this.dependents.set(childKey, new Set());
    }

    const parentDeps = this.dependencies.get(parentKey)!;
    if (!parentDeps.has(childKey)) {
      if (this.hasPath(childKey, parentKey)) {
        const error = new Error(`circular dependency detected: ${formatServiceKey(parentKey)} -> ${formatServiceKey(childKey)}`);
        this.emit({ type: 'container:error', error });
        throw error;
      }
      parentDeps.add(childKey);
      this.dependents.get(childKey)!.add(parentKey);
    }
  }

  public on(listener: (event: ContainerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public off(listener: (event: ContainerEvent) => void) {
    this.listeners.delete(listener);
  }

  public getLifecycle(key: ServiceKey): ServiceLifecycleStage | undefined {
    return this.paddings.get(key)?.lifecycle;
  }

  public getDependencyGraph() {
    const nodes = Array.from(this.registeredKeys).sort(
      (a, b) => (this.keyOrdinal.get(a)! - this.keyOrdinal.get(b)!),
    );
    const edges: Array<{ from: ServiceKey; to: ServiceKey }> = [];

    for (const [fromKey, deps] of this.dependencies.entries()) {
      for (const toKey of deps) {
        edges.push({ from: fromKey, to: toKey });
      }
    }

    return { nodes, edges };
  }

  public getStartupOrder() {
    return [...this.startupOrder];
  }

  public register<R>(key: ServiceKey, fn: ServiceFunction<R>): ServiceRegisterProps<R> {
    if (!this.keyOrdinal.has(key)) {
      this.keyOrdinal.set(key, this.nextOrdinal());
    }
    this.registeredKeys.add(key);
    return { key, fn, flag: sericeFlag };
  }

  public resolve<R>(props: ServiceRegisterProps<R>): Promise<R> {
    const { key, fn } = props;
    const stack = this.context.getStore() || [];
    const parentKey = stack.length ? stack[stack.length - 1] : undefined;

    if (parentKey !== undefined) {
      this.trackDependency(parentKey, key);
    }

    return new Promise<R>((resolve, reject) => {
      if (!this.paddings.has(key)) {
        return this.run(key, fn, (e, v) => {
          if (e) {
            reject(e);
          } else {
            resolve(v!);
          }
        })
      }
      const state = this.paddings.get(key)!;
      switch (state.status) {
        case 0:
          state.queue.add({ resolve, reject });
          break;
        case 1:
          resolve(state.value);
          break;
        case -1:
          reject(state.error);
          break;
      }
    })
  }

  private run<R>(key: ServiceKey, fn: ServiceFunction<R>, callback: (e: any, v?: R) => void) {
    const state: Paddings = {
      status: 0,
      lifecycle: 'init',
      value: undefined,
      queue: new Set(),
      startedAt: Date.now(),
    }
    this.paddings.set(key, state);
    if (!this.startupOrder.includes(key)) {
      this.startupOrder.push(key);
    }
    this.emit({ type: 'service:init', key });

    const curDown: ServiceCutDownHandler = (cutDownFn: ServiceCutDownFunction) => {
      if (!this.shutdownQueues.includes(key)) {
        this.shutdownQueues.push(key);
      }
      if (!this.shutdownFunctions.has(key)) {
        this.shutdownFunctions.set(key, []);
      }
      const pools = this.shutdownFunctions.get(key)!;
      if (!pools.includes(cutDownFn)) {
        pools.push(cutDownFn);
      }
    }

    const parentStack = this.context.getStore() || [];
    const startupPromise = this.context.run([...parentStack, key], () => Promise.resolve(fn(curDown)));

    withTimeout(
      startupPromise,
      this.options.startTimeoutMs,
      `service startup timeout: ${formatServiceKey(key)} exceeded ${this.options.startTimeoutMs}ms`
    ).then((value) => {
      state.status = 1;
      state.lifecycle = 'ready';
      state.value = value;
      state.endedAt = Date.now();
      const durationMs = state.endedAt - state.startedAt;
      this.emit({ type: 'service:ready', key, durationMs });

      for (const queue of state.queue) {
        queue.resolve(value);
      }
      state.queue.clear();
      callback(null, value);
    }).catch(e => {
      state.status = -1;
      state.lifecycle = 'stopping';
      state.error = e;
      state.endedAt = Date.now();
      const durationMs = state.endedAt - state.startedAt;
      this.emit({ type: 'service:error', key, error: e, durationMs });

      const clear = () => {
        state.lifecycle = 'stopped';
        for (const queue of state.queue) {
          queue.reject(e);
        }
        state.queue.clear();
        callback(e);
      }

      this.shutdownService(key)
        .then(clear)
        .catch((shutdownError) => {
          this.emit({ type: 'service:shutdown:error', key, error: shutdownError });
          clear();
        });
    })
  }

  private async shutdownService(key: ServiceKey) {
    if (this.shutdownQueues.includes(key)) {
      const meta = this.paddings.get(key);
      if (meta) {
        meta.lifecycle = 'stopping';
      }

      this.emit({ type: 'service:shutdown:start', key });
      const startedAt = Date.now();

      const pools = this.shutdownFunctions.get(key)!;
      let i = pools.length;
      while (i--) {
        const teardown = pools[i];
        try {
          await withTimeout(
            Promise.resolve(teardown()),
            this.options.shutdownTimeoutMs,
            `service shutdown timeout: ${formatServiceKey(key)} exceeded ${this.options.shutdownTimeoutMs}ms`
          );
        } catch (error) {
          this.emit({ type: 'service:shutdown:error', key, error });
        }
      }

      this.shutdownFunctions.delete(key);
      this.shutdownQueues.splice(this.shutdownQueues.indexOf(key), 1);

      if (meta) {
        meta.lifecycle = 'stopped';
      }

      this.emit({ type: 'service:shutdown:done', key, durationMs: Date.now() - startedAt });
    }
  }

  public async shutdown() {
    const startedAt = Date.now();
    this.emit({ type: 'container:shutdown:start' });

    // 循环直到队列清空；再让出一次事件循环，处理「shutdown 期间才调用 curDown」的晚注册 teardown
    while (true) {
      while (this.shutdownQueues.length > 0) {
        const key = this.shutdownQueues[this.shutdownQueues.length - 1];
        await this.shutdownService(key);
      }
      await new Promise<void>(r => setImmediate(r));
      if (this.shutdownQueues.length === 0) break;
    }
    this.shutdownFunctions.clear();
    this.shutdownQueues.length = 0;

    this.emit({ type: 'container:shutdown:done', durationMs: Date.now() - startedAt });
  }

  public hasService(key: ServiceKey) {
    return this.registeredKeys.has(key);
  }

  public hasMeta(key: ServiceKey) {
    return this.paddings.has(key);
  }

  public getMetaByKey(key: ServiceKey) {
    return this.paddings.get(key);
  }
}

function getGlobalContainer() {
  if (!globalThis.HILE_GLOBAL_CONTAINER) {
    globalThis.HILE_GLOBAL_CONTAINER = new Container();
  }
  return globalThis.HILE_GLOBAL_CONTAINER;
}

export const container = getGlobalContainer();
export function defineService<R>(key: ServiceKey, fn: ServiceFunction<R>) {
  return container.register(key, fn);
}

export function loadService<R>(props: ServiceRegisterProps<R>): Promise<R> {
  return container.resolve(props);
}

export function isService<R>(props: ServiceRegisterProps<R>) {
  return (
    props.flag === sericeFlag
    && typeof props.fn === 'function'
    && (typeof props.key === 'string' || typeof props.key === 'symbol')
  );
}

export default container;
