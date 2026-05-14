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

export type ApplicationProps = {
  namespace: string;
  registry: RegistryAddress;
  /** `/-/find` 等待响应的上限（毫秒），默认 `10000` */
  registryLookupTimeoutMs?: number;
} & MicroServerProps;

export class Application extends Server {
  private registry?: Client;
  private reconnectTimeout?: NodeJS.Timeout;
  private registryReconnectPromise: Promise<void> | undefined;
  /** 为 true 时不再向 Registry 重连（listen 返回的 teardown 已触发） */
  private stopped = false;
  private readonly _registry_address: RegistryAddress;
  private readonly _registryLookupTimeoutMs: number;

  private readonly namespaces = new Map<string, {
    host: string;
    port: number;
    status: RegistryLookupStatus;
    handlers: Set<[(value: Client) => void, (reason?: any) => void]>
  }>();
  private static readonly HEARTBEAT_INTERVAL = 10000;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private static readonly CB_COOLDOWN_MS = 30_000;
  private readonly circuitBreakers = new Map<string, Map<string, number>>();

  constructor(props: ApplicationProps) {
    const { namespace, registry, registryLookupTimeoutMs = 10_000, ...microAndLoader } = props;
    super(namespace, microAndLoader);
    assertValidRegistrySocket('registry address', registry.host, registry.port);
    this._registry_address = registry;
    this._registryLookupTimeoutMs = registryLookupTimeoutMs;
  }

  public async listen(port: number = 0) {
    this.stopped = false;
    const callback = await super.listen(port);
    try {
      await this.reconnectToRegistry();
      this.startHeartbeat();
    } catch (err) {
      try {
        await callback();
      } catch {
        // ignore secondary errors from teardown
      }
      throw err;
    }
    return async () => {
      this.stopped = true;
      this.stopHeartbeat();
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
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
    })().finally(() => {
      this.registryReconnectPromise = undefined;
    });

    return this.registryReconnectPromise;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.registry) return;
      try {
        this.registry.push('/-/heartbeat', {});
      } catch {
        // registry connection may have dropped between null-check and push
      }
    }, Application.HEARTBEAT_INTERVAL);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
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
    const { response } = this.registry.request('/-/find', { namespace, exclude });
    return await withTimeout(response<{ host: string, port: number } | undefined>(), this._registryLookupTimeoutMs, 'Registry /-/find');
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
          this.namespaces.delete(namespace);
          for (const [_, reject] of stack.handlers.values()) {
            reject(e);
          }
        }).finally(() => stack.handlers.clear())
      }
    })
  }

  public async call<T = any>(namespace: string, url: string, data: unknown): Promise<T> {
    const exclude = this.getActiveExcludes(namespace);
    let client: Client;

    try {
      client = await this.get(namespace, exclude);
    } catch {
      // All peers excluded → reset breaker and retry
      this.circuitBreakers.delete(namespace);
      client = await this.get(namespace);
    }

    try {
      const { response } = client.request(url, data);
      const result = await response<T>();
      this.recordSuccess(namespace, client.host, client.port);
      return result;
    } catch (err) {
      this.recordFailure(namespace, client.host, client.port);
      throw err;
    }
  }
}
