import { Client } from './client';
import { Server, type MicroServerProps } from './server';
import { RegistryAddress } from './registry';

enum RegistryLookupStatus {
  IDLE,
  PENDING,
  READY,
}

function assertValidRegistrySocket(meta: string, host: string, port: number): void {
  if (typeof host !== 'string' || !host || host.length > 253) {
    throw new Error(`Invalid ${meta}: empty or oversized host`);
  }
  if (/[\s\r\n\0]/.test(host)) throw new Error(`Invalid ${meta}: host contains whitespace`);
  if (!Number.isFinite(port) || port !== Math.trunc(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${meta}: port must be integer 1..65535`);
  }
  if (host.includes(':') && !host.startsWith('[')) {
    throw new Error(`Invalid ${meta}: IPv6 host must be bracketed (e.g. [::1])`);
  }
  if (host.includes('/') || host.includes('?')) {
    throw new Error(`Invalid ${meta}: illegal host characters`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

type UnionToIntersection<U> =
  (U extends any ? (x: U) => void : never) extends (x: infer I) => void ? I : never;

type EnvRequest<T extends Record<string, Record<string, any>>> = {
  [N in keyof T]: {
    namespace: N;
    fields?: readonly (keyof T[N])[];
  };
}[keyof T];

type EnvFieldsForRequest<
  T extends Record<string, Record<string, any>>,
  N extends keyof T,
  F,
> = F extends readonly (infer K extends keyof T[N])[] ? Pick<T[N], K> : T[N];

type EnvRequestResult<
  T extends Record<string, Record<string, any>>,
  R,
> = R extends { namespace: infer N extends keyof T, fields?: infer F }
  ? { [K in N]: EnvFieldsForRequest<T, N, F> }
  : never;

export type GetEnvVariablesResult<
  T extends Record<string, Record<string, any>>,
  Requests extends readonly EnvRequest<T>[],
> = UnionToIntersection<EnvRequestResult<T, Requests[number]>>;

export type ApplicationProps = {
  namespace: string;
  registry: RegistryAddress;
  /** `/-/find` 等待响应的上限（毫秒），默认 `10000` */
  registryLookupTimeoutMs?: number;
  /** 单次 request() 等待响应的上限（毫秒），默认 `30000` */
  requestTimeoutMs?: number;
} & MicroServerProps;

export class Application extends Server {
  private registry?: Client;
  private reconnectTimeout?: NodeJS.Timeout;
  private registryReconnectPromise: Promise<void> | undefined;
  /** 为 true 时不再向 Registry 重连（listen 返回的 teardown 已触发） */
  private stopped = false;
  private readonly _registry_address: RegistryAddress;
  private readonly _registryLookupTimeoutMs: number;
  private readonly _requestTimeoutMs: number;

  private readonly namespaces = new Map<string, {
    host: string;
    port: number;
    status: RegistryLookupStatus;
    handlers: Set<[(value: Client) => void, (reason?: any) => void]>
  }>();
  private static readonly CB_COOLDOWN_MS = 30_000;
  private readonly circuitBreakers = new Map<string, Map<string, number>>();
  private readonly fallbacks = new Set<() => void>();
  private readonly topics = new Map<string, (data: any) => any>();

  constructor(props: ApplicationProps) {
    const { namespace, registry, registryLookupTimeoutMs = 10_000, requestTimeoutMs = 30_000, ...microAndLoader } = props;
    super(namespace, microAndLoader);
    assertValidRegistrySocket('registry address', registry.host, registry.port);
    this._registry_address = registry;
    this._registryLookupTimeoutMs = registryLookupTimeoutMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this.fallbacks.add(this.register('/-/health', async () => ({
      status: 'ok' as const,
      registry: !!this.registry,
      uptime: process.uptime(),
      namespaces: [...this.namespaces.keys()],
    })))
    this.fallbacks.add(this.register<{ topic: string, payload: any }>('/-/topic/update', async ({ data }) => {
      this.events.emit('topic:' + data.topic, data.payload);
      return Date.now();
    }))
  }

  public async listen(port: number = 0) {
    this.stopped = false;
    const callback = await super.listen(port);
    try {
      await this.reconnectToRegistry();
    } catch (err) {
      try {
        await callback();
      } catch {
        // ignore secondary errors from teardown
      }
      throw err;
    }
    // 这里不清理 topics 由业务方自己清理
    // 这里也不清理 declare 和 undeclare 由业务方自己清理
    return async () => {
      for (const fallback of this.fallbacks) {
        fallback();
      }
      this.fallbacks.clear();
      this.stopped = true;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      this.registry?.dispose();
      this.registry = undefined;
      await callback();
    };
  }

  private scheduleRegistryRetry() {
    if (this.stopped) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      void this.reconnectToRegistry().catch(() => {
        if (this.stopped) return;
        this.scheduleRegistryRetry();
      });
    }, 3000);
  }

  private async reconnectToRegistry(): Promise<void> {
    if (this.stopped) return;
    if (this.registryReconnectPromise) return this.registryReconnectPromise;

    this.registryReconnectPromise = (async () => {
      const registry = await this.connect(this._registry_address.host, this._registry_address.port);
      if (this.stopped) {
        registry.dispose();
        return;
      }
      registry.events.once('disconnect', () => {
        if (this.registry !== registry) return;
        this.registry = undefined;
        if (this.stopped) return;
        void this.reconnectToRegistry().catch(() => {
          if (this.stopped) return;
          this.scheduleRegistryRetry();
        });
      });
      this.registry = registry;
      // 重新订阅所有 topic
      for (const [topic, callback] of this.topics) {
        await this.subscribe(topic, callback, true);
      }
    })().finally(() => {
      this.registryReconnectPromise = undefined;
    });

    return this.registryReconnectPromise;
  }

  private recordSuccess(ns: string, host: string, port: number) {
    const excludes = this.circuitBreakers.get(ns);
    if (excludes) {
      excludes.delete(`${host}:${port}`);
      if (excludes.size === 0) this.circuitBreakers.delete(ns);
    }
  }

  private recordFailure(ns: string, host: string, port: number) {
    let excludes = this.circuitBreakers.get(ns);
    if (!excludes) {
      excludes = new Map();
      this.circuitBreakers.set(ns, excludes);
    }
    excludes.set(`${host}:${port}`, Date.now());
  }

  private getActiveExcludes(ns: string): string[] {
    const excludes = this.circuitBreakers.get(ns);
    if (!excludes) return [];
    const now = Date.now();
    const active: string[] = [];
    for (const [key, openedAt] of excludes) {
      if (now - openedAt >= Application.CB_COOLDOWN_MS) {
        excludes.delete(key);
      } else {
        active.push(key);
      }
    }
    if (excludes.size === 0) this.circuitBreakers.delete(ns);
    return active;
  }

  private async findFromRegistry(namespace: string, exclude?: string[]) {
    if (!this.registry) throw new Error('Registry not found');
    const promise = this.registry.request<{ host: string, port: number } | undefined>('/-/find', { namespace, exclude });
    return await withTimeout(promise, this._registryLookupTimeoutMs, 'Registry /-/find');
  }

  public get(namespace: string, exclude?: string[]) {
    if (!this.namespaces.has(namespace)) {
      this.namespaces.set(namespace, {
        host: '',
        port: 0,
        status: RegistryLookupStatus.IDLE,
        handlers: new Set(),
      });
    }
    const stack = this.namespaces.get(namespace)!;
    // Save old cache info before potential invalidation (used for cache degradation)
    const cachedHost = stack.host;
    const cachedPort = stack.port;
    if (
      stack.status === RegistryLookupStatus.READY &&
      (!this.clients.has(`${stack.host}:${stack.port}`) ||
        (exclude?.length && exclude.includes(`${stack.host}:${stack.port}`)))
    ) {
      stack.status = RegistryLookupStatus.IDLE;
      stack.host = '';
      stack.port = 0;
    }
    const key = `${stack.host}:${stack.port}`;
    if (stack.status === RegistryLookupStatus.READY && this.clients.has(key)) {
      return Promise.resolve(this.clients.get(key)!);
    }

    return new Promise<Client>((resolve, reject) => {
      stack.handlers.add([resolve, reject]);
      if (stack.status === RegistryLookupStatus.IDLE) {
        stack.status = RegistryLookupStatus.PENDING;
        this.findFromRegistry(namespace, exclude).then(data => {
          if (!data) return Promise.reject(new Error('Namespace not found'));
          assertValidRegistrySocket('peer address from registry', data.host, data.port);
          return this.connect(data.host, data.port).then(client => {
            stack.host = data.host;
            stack.port = data.port;
            stack.status = RegistryLookupStatus.READY;
            for (const [resolve] of stack.handlers.values()) {
              resolve(client);
            }
            return client;
          })
        }).then(client => {
          client.events.on('disconnect', () => {
            if (this.namespaces.has(namespace)) {
              this.namespaces.delete(namespace);
            }
          });
        }).catch(e => {
          // Registry unavailable but previously cached client still valid -> degrade
          const cachedKey = `${cachedHost}:${cachedPort}`;
          if (cachedHost && this.clients.has(cachedKey)) {
            const client = this.clients.get(cachedKey)!;
            // Restore cache so subsequent calls hit the fast path
            stack.host = cachedHost;
            stack.port = cachedPort;
            stack.status = RegistryLookupStatus.READY;
            for (const [resolve] of stack.handlers.values()) {
              resolve(client);
            }
            return;
          }
          this.namespaces.delete(namespace);
          for (const [_, reject] of stack.handlers.values()) {
            reject(e);
          }
        }).finally(() => stack.handlers.clear())
      }
    })
  }

  public async call<T = any>(namespace: string, url: string, data: any, options?: {
    timeout?: number,
    retries?: number,
    signal?: AbortSignal
  }): Promise<T> {
    const { timeout = this._requestTimeoutMs, retries = 1, signal } = options || {};
    const exclude = this.getActiveExcludes(namespace);
    let client: Client;

    try {
      client = await this.get(namespace, exclude);
    } catch {
      this.circuitBreakers.delete(namespace);
      client = await this.get(namespace);
    }

    try {
      const result = await client.request<T>(url, data, {
        timeout: timeout ?? this._requestTimeoutMs,
        signal,
      });
      this.recordSuccess(namespace, client.host, client.port);
      return result;
    } catch (err) {
      this.recordFailure(namespace, client.host, client.port);
      if (retries > 0) {
        return this.call(namespace, url, data, { timeout, retries: retries - 1, signal });
      }
      throw err;
    }
  }

  public async stream(
    namespace: string,
    url: string,
    data: any,
    options?: {
      signal?: AbortSignal,
      retries?: number
    },
  ): Promise<import('stream').Readable> {
    const { signal, retries = 1 } = options || {};
    const exclude = this.getActiveExcludes(namespace);
    let client: Client;

    try {
      client = await this.get(namespace, exclude);
    } catch {
      this.circuitBreakers.delete(namespace);
      client = await this.get(namespace);
    }

    try {
      const readable = client.stream(url, data, { signal });
      this.recordSuccess(namespace, client.host, client.port);
      return readable;
    } catch (err) {
      this.recordFailure(namespace, client.host, client.port);
      if (retries > 0) {
        return this.stream(namespace, url, data, { signal, retries: retries - 1 });
      }
      throw err;
    }
  }

  public async publish<T = any>(topic: string, data: T) {
    if (!this.registry) throw new Error('Registry not found');
    await this.registry.request<number>('/-/declare', { topic, payload: data });
    const ref = {
      update: async (payload: T) => {
        if (!this.registry) throw new Error('Registry not found');
        await this.registry.request<number>('/-/topic/update', { topic, payload });
        return ref;
      },
      unpublish: async () => {
        if (!this.registry) throw new Error('Registry not found');
        await this.registry.request<number>('/-/undeclare', { topic });
        return ref;
      }
    }
    return ref;
  }

  /** 对同一 topic 重复 subscribe 是幂等的：第二次调用只返回 unsubscribe 函数，不会注册第二个 callback */
  public async subscribe<T = any>(topic: string, callback: (data: T) => any, isReconnect = false) {
    if (!this.registry) throw new Error('Registry not found');
    const fallback = async () => {
      if (!this.registry) throw new Error('Registry not found');
      await this.registry.request<number>('/-/unsubscribe', { topic });
      if (this.topics.has(topic)) {
        const _callback = this.topics.get(topic)!;
        this.events.off('topic:' + topic, _callback);
        this.topics.delete(topic);
      }
    }
    if (this.topics.has(topic) && !isReconnect) return fallback;
    const payload = await this.registry.request<T>('/-/subscribe', { topic });
    if (!isReconnect) {
      this.events.on('topic:' + topic, callback);
      this.topics.set(topic, callback);
      callback(payload);
    }
    return fallback;
  }
}