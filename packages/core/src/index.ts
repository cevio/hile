import { AsyncLocalStorage } from 'node:async_hooks';

export type ServiceCutDownFunction = () => unknown | Promise<unknown>;
export type ServiceCutDownHandler = (fn: ServiceCutDownFunction) => void;
export type ServiceFunction<R> = (fn: ServiceCutDownHandler) => R | Promise<R>;
const sericeFlag = Symbol('service');

export type ServiceLifecycleStage = 'init' | 'ready' | 'stopping' | 'stopped';

export interface ServiceRegisterProps<R> {
  id: number
  fn: ServiceFunction<R>
  flag: typeof sericeFlag;
}

export interface ContainerOptions {
  startTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export type ContainerEvent =
  | { type: 'service:init'; id: number }
  | { type: 'service:ready'; id: number; durationMs: number }
  | { type: 'service:error'; id: number; error: any; durationMs: number }
  | { type: 'service:shutdown:start'; id: number }
  | { type: 'service:shutdown:done'; id: number; durationMs: number }
  | { type: 'service:shutdown:error'; id: number; error: any }
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

export class Container {
  private id = 1;
  private readonly packages = new Map<Function, number>();
  private readonly paddings = new Map<number, Paddings>();

  private readonly dependencies = new Map<number, Set<number>>();
  private readonly dependents = new Map<number, Set<number>>();

  private readonly shutdownFunctions = new Map<number, ServiceCutDownFunction[]>();
  private readonly shutdownQueues: number[] = [];
  private readonly startupOrder: number[] = [];

  private readonly listeners = new Set<(event: ContainerEvent) => void>();
  private readonly context = new AsyncLocalStorage<number[]>();

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

  private getId() {
    let i = this.id++;
    if (i >= Number.MAX_SAFE_INTEGER) {
      i = this.id = 1;
    }
    return i;
  }

  private hasPath(from: number, to: number, visited = new Set<number>()): boolean {
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

  private trackDependency(parentId: number, childId: number) {
    if (parentId === childId) {
      throw new Error(`circular dependency detected: ${parentId} -> ${childId}`);
    }

    if (!this.dependencies.has(parentId)) {
      this.dependencies.set(parentId, new Set());
    }
    if (!this.dependents.has(childId)) {
      this.dependents.set(childId, new Set());
    }

    const parentDeps = this.dependencies.get(parentId)!;
    if (!parentDeps.has(childId)) {
      if (this.hasPath(childId, parentId)) {
        const error = new Error(`circular dependency detected: ${parentId} -> ${childId}`);
        this.emit({ type: 'container:error', error });
        throw error;
      }
      parentDeps.add(childId);
      this.dependents.get(childId)!.add(parentId);
    }
  }

  public onEvent(listener: (event: ContainerEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public offEvent(listener: (event: ContainerEvent) => void) {
    this.listeners.delete(listener);
  }

  public getLifecycle(id: number): ServiceLifecycleStage | undefined {
    return this.paddings.get(id)?.lifecycle;
  }

  public getDependencyGraph() {
    const nodes = Array.from(this.packages.values()).sort((a, b) => a - b);
    const edges: Array<{ from: number; to: number }> = [];

    for (const [id, deps] of this.dependencies.entries()) {
      for (const dep of deps) {
        edges.push({ from: id, to: dep });
      }
    }

    return { nodes, edges };
  }

  public getStartupOrder() {
    return [...this.startupOrder];
  }

  public register<R>(fn: ServiceFunction<R>): ServiceRegisterProps<R> {
    if (this.packages.has(fn)) {
      return { id: this.packages.get(fn)!, fn, flag: sericeFlag }
    }
    const id = this.getId();
    this.packages.set(fn, id);
    return { id, fn, flag: sericeFlag }
  }

  public resolve<R>(props: ServiceRegisterProps<R>): Promise<R> {
    const { id, fn } = props;
    const stack = this.context.getStore() || [];
    const parentId = stack.length ? stack[stack.length - 1] : undefined;

    if (parentId !== undefined) {
      this.trackDependency(parentId, id);
    }

    return new Promise<R>((resolve, reject) => {
      if (!this.paddings.has(id)) {
        return this.run(id, fn, (e, v) => {
          if (e) {
            reject(e);
          } else {
            resolve(v!);
          }
        })
      }
      const state = this.paddings.get(id)!;
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

  private run<R>(id: number, fn: ServiceFunction<R>, callback: (e: any, v?: R) => void) {
    const state: Paddings = {
      status: 0,
      lifecycle: 'init',
      value: undefined,
      queue: new Set(),
      startedAt: Date.now(),
    }
    this.paddings.set(id, state);
    if (!this.startupOrder.includes(id)) {
      this.startupOrder.push(id);
    }
    this.emit({ type: 'service:init', id });

    const curDown: ServiceCutDownHandler = (cutDownFn: ServiceCutDownFunction) => {
      if (!this.shutdownQueues.includes(id)) {
        this.shutdownQueues.push(id);
      }
      if (!this.shutdownFunctions.has(id)) {
        this.shutdownFunctions.set(id, []);
      }
      const pools = this.shutdownFunctions.get(id)!;
      if (!pools.includes(cutDownFn)) {
        pools.push(cutDownFn);
      }
    }

    const parentStack = this.context.getStore() || [];
    const startupPromise = this.context.run([...parentStack, id], () => Promise.resolve(fn(curDown)));

    withTimeout(
      startupPromise,
      this.options.startTimeoutMs,
      `service startup timeout: ${id} exceeded ${this.options.startTimeoutMs}ms`
    ).then((value) => {
      state.status = 1;
      state.lifecycle = 'ready';
      state.value = value;
      state.endedAt = Date.now();
      const durationMs = state.endedAt - state.startedAt;
      this.emit({ type: 'service:ready', id, durationMs });

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
      this.emit({ type: 'service:error', id, error: e, durationMs });

      const clear = () => {
        state.lifecycle = 'stopped';
        for (const queue of state.queue) {
          queue.reject(e);
        }
        state.queue.clear();
        callback(e);
      }

      this.shutdownService(id)
        .then(clear)
        .catch((shutdownError) => {
          this.emit({ type: 'service:shutdown:error', id, error: shutdownError });
          clear();
        });
    })
  }

  private async shutdownService(id: number) {
    if (this.shutdownQueues.includes(id)) {
      const meta = this.paddings.get(id);
      if (meta) {
        meta.lifecycle = 'stopping';
      }

      this.emit({ type: 'service:shutdown:start', id });
      const startedAt = Date.now();

      const pools = this.shutdownFunctions.get(id)!;
      let i = pools.length;
      while (i--) {
        const teardown = pools[i];
        try {
          await withTimeout(
            Promise.resolve(teardown()),
            this.options.shutdownTimeoutMs,
            `service shutdown timeout: ${id} exceeded ${this.options.shutdownTimeoutMs}ms`
          );
        } catch (error) {
          this.emit({ type: 'service:shutdown:error', id, error });
        }
      }

      this.shutdownFunctions.delete(id);
      this.shutdownQueues.splice(this.shutdownQueues.indexOf(id), 1);

      if (meta) {
        meta.lifecycle = 'stopped';
      }

      this.emit({ type: 'service:shutdown:done', id, durationMs: Date.now() - startedAt });
    }
  }

  public async shutdown() {
    const startedAt = Date.now();
    this.emit({ type: 'container:shutdown:start' });

    let i = this.shutdownQueues.length;
    while (i--) {
      await this.shutdownService(this.shutdownQueues[i]);
    }
    this.shutdownFunctions.clear();
    this.shutdownQueues.length = 0;

    this.emit({ type: 'container:shutdown:done', durationMs: Date.now() - startedAt });
  }

  public hasService<R>(fn: ServiceFunction<R>) {
    return this.packages.has(fn);
  }

  public hasMeta(id: number) {
    return this.paddings.has(id);
  }

  public getIdByService<R>(fn: ServiceFunction<R>) {
    return this.packages.get(fn);
  }

  public getMetaById(id: number) {
    return this.paddings.get(id);
  }
}

export const container = new Container();
export function defineService<R>(fn: ServiceFunction<R>) {
  return container.register(fn);
}

export function loadService<R>(props: ServiceRegisterProps<R>): Promise<R> {
  return container.resolve(props);
}

export function isService<R>(props: ServiceRegisterProps<R>) {
  return props.flag === sericeFlag && typeof props.id === 'number' && typeof props.fn === 'function';
}

export default container;
