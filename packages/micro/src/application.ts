import { Client, type ClientStreamOptions } from './client';
import { Server, type MicroServerProps } from './server';
import type {
  RegistryAddress,
  RegistryTopicSnapshot,
  RegistryTopicSnapshotsResult,
  RegistryTopicSummary,
  RegistryTopicsResult,
} from './registry';

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

function createPubSubPayloadSnapshot<T = any>(topic: string, payload: T): T {
  const serialized = JSON.stringify({ topic, payload });
  const parsed = JSON.parse(serialized);
  if (Object.prototype.hasOwnProperty.call(parsed, 'payload')) {
    return parsed.payload;
  }
  return undefined as T;
}

function stablePayloadSignature(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return `string:${JSON.stringify(value)}`;
  if (type === 'number') return `number:${String(value)}`;
  if (type === 'boolean') return `boolean:${String(value)}`;
  if (Array.isArray(value)) {
    return `array:[${value.map(stablePayloadSignature).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return `object:{${keys.map(key => `${JSON.stringify(key)}:${stablePayloadSignature(value[key])}`).join(',')}}`;
  }
  return `${type}:${String(value)}`;
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

export type CircuitBreakerStatus = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOptions = {
  /** 连续失败达到阈值后打开熔断器，默认 3 */
  failureThreshold?: number;
  /** 连续失败统计窗口（毫秒），默认 60000 */
  failureWindowMs?: number;
  /** half-open 探测连续成功达到阈值后恢复，默认 2 */
  successThreshold?: number;
  /** 首次打开后的冷却时间（毫秒），默认 10000 */
  cooldownMs?: number;
  /** 指数退避冷却时间上限（毫秒），默认 120000 */
  maxCooldownMs?: number;
  /** half-open 状态下同时放行的探测请求数，默认 1 */
  halfOpenMaxProbes?: number;
  /** 返回 false 的错误不会计入熔断，默认全部计入 */
  shouldRecordFailure?: (err: unknown) => boolean;
  /** 返回 false 的错误不会自动重试，默认全部允许重试 */
  shouldRetry?: (err: unknown) => boolean;
};

type ResolvedCircuitBreakerOptions = Required<CircuitBreakerOptions>;

type CircuitBreakerPeerState = {
  status: CircuitBreakerStatus;
  failures: number;
  successes: number;
  openedAt: number;
  nextAttemptAt: number;
  cooldownMs: number;
  lastFailureAt: number;
  halfOpenInFlight: number;
};

type CircuitBreakerProbe = {
  acquired: boolean;
  wasHalfOpen: boolean;
  cooldownMs: number;
  release: () => void;
};

type RegistryLookupOptions = {
  allowExcludedCachedFallback?: boolean;
};

const DEFAULT_CIRCUIT_BREAKER: ResolvedCircuitBreakerOptions = {
  failureThreshold: 3,
  failureWindowMs: 60_000,
  successThreshold: 2,
  cooldownMs: 10_000,
  maxCooldownMs: 120_000,
  halfOpenMaxProbes: 1,
  shouldRecordFailure: () => true,
  shouldRetry: () => true,
};

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 1) return fallback;
  return Math.trunc(value);
}

function resolveCircuitBreakerOptions(options?: CircuitBreakerOptions): ResolvedCircuitBreakerOptions {
  const cooldownMs = positiveIntegerOr(options?.cooldownMs, DEFAULT_CIRCUIT_BREAKER.cooldownMs);
  const configuredMaxCooldownMs = positiveIntegerOr(
    options?.maxCooldownMs,
    DEFAULT_CIRCUIT_BREAKER.maxCooldownMs,
  );
  return {
    failureThreshold: positiveIntegerOr(
      options?.failureThreshold,
      DEFAULT_CIRCUIT_BREAKER.failureThreshold,
    ),
    failureWindowMs: positiveIntegerOr(
      options?.failureWindowMs,
      DEFAULT_CIRCUIT_BREAKER.failureWindowMs,
    ),
    successThreshold: positiveIntegerOr(
      options?.successThreshold,
      DEFAULT_CIRCUIT_BREAKER.successThreshold,
    ),
    cooldownMs,
    maxCooldownMs: Math.max(cooldownMs, configuredMaxCooldownMs),
    halfOpenMaxProbes: positiveIntegerOr(
      options?.halfOpenMaxProbes,
      DEFAULT_CIRCUIT_BREAKER.halfOpenMaxProbes,
    ),
    shouldRecordFailure: options?.shouldRecordFailure ?? DEFAULT_CIRCUIT_BREAKER.shouldRecordFailure,
    shouldRetry: options?.shouldRetry ?? DEFAULT_CIRCUIT_BREAKER.shouldRetry,
  };
}

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
  /** 本地内存熔断策略配置 */
  circuitBreaker?: CircuitBreakerOptions;
} & MicroServerProps;

type TopicSnapshot<T = any> = {
  hasData: boolean;
  payload: T;
};

export class Application extends Server {
  private registry?: Client;
  private reconnectTimeout?: NodeJS.Timeout;
  private registryReconnectPromise: Promise<void> | undefined;
  private registryReconnectGeneration = 0;
  /** 为 true 时不再向 Registry 重连（listen 返回的 teardown 已触发） */
  private stopped = false;
  private listenGeneration = 0;
  private readonly _registry_address: RegistryAddress;
  private readonly _registryLookupTimeoutMs: number;
  private readonly _requestTimeoutMs: number;
  private readonly _circuitBreaker: ResolvedCircuitBreakerOptions;

  private readonly namespaces = new Map<string, {
    host: string;
    port: number;
    status: RegistryLookupStatus;
    handlers: Set<[(value: Client) => void, (reason?: any) => void]>
  }>();
  private readonly circuitBreakers = new Map<string, Map<string, CircuitBreakerPeerState>>();
  private readonly topics = new Map<string, Set<(data: any) => any>>();
  private readonly publishedTopics = new Map<string, any>();
  private readonly publishedTopicRevisions = new Map<string, number>();
  private readonly publishedTopicDirty = new Set<string>();
  private readonly publishedTopicVersions = new Map<string, number>();
  private readonly publishedTopicSignatures = new Map<string, string>();
  private readonly pendingUnpublishes = new Set<string>();
  private readonly topicSyncs = new Map<string, Promise<void>>();
  private readonly topicUpdateVersions = new Map<string, number>();
  private publishIntentVersion = 0;

  constructor(props: ApplicationProps) {
    const {
      namespace,
      registry,
      registryLookupTimeoutMs = 10_000,
      requestTimeoutMs = 30_000,
      circuitBreaker,
      ...microAndLoader
    } = props;
    super(namespace, microAndLoader);
    assertValidRegistrySocket('registry address', registry.host, registry.port);
    this._registry_address = registry;
    this._registryLookupTimeoutMs = registryLookupTimeoutMs;
    this._requestTimeoutMs = requestTimeoutMs;
    this._circuitBreaker = resolveCircuitBreakerOptions(circuitBreaker);
    this.events.on('disconnect', (client: Client) => {
      const disconnectedKey = `${client.host}:${client.port}`;
      // 一个物理连接可承载多个 namespace；集中清理可避免每次服务发现都向 Client 重复注册监听器。
      for (const [namespace, stack] of this.namespaces) {
        if (`${stack.host}:${stack.port}` !== disconnectedKey) continue;
        this.namespaces.delete(namespace);
      }
    });
    this.register('/-/health', async () => ({
      status: 'ok' as const,
      registry: !!this.registry,
      uptime: process.uptime(),
      namespaces: [...this.namespaces.keys()],
    }))
    this.register<{ topic: string, payload: any }>('/-/topic/update', async ({ data }) => {
      this.dispatchTopicUpdate(data.topic, data.payload);
      return Date.now();
    })
  }

  private dispatchTopicUpdate(topic: string, payload: any) {
    this.topicUpdateVersions.set(topic, (this.topicUpdateVersions.get(topic) ?? 0) + 1);
    for (const listener of this.events.listeners('topic:' + topic)) {
      try {
        const listenerPayload = createPubSubPayloadSnapshot(topic, payload);
        void Promise.resolve((listener as (data: any) => any)(listenerPayload)).catch(err => {
          this.logger.error(err);
        });
      } catch (err) {
        this.logger.error(err);
      }
    }
  }

  public async listen(port: number = 0) {
    const generation = ++this.listenGeneration;
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
      this.stopped = true;
      if (this.listenGeneration === generation) {
        this.listenGeneration++;
      }
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = undefined;
      }
      this.registry?.dispose();
      this.registry = undefined;
      await callback();
    };
  }

  private scheduleRegistryRetry(generation = this.listenGeneration) {
    if (this.stopped || this.listenGeneration !== generation) return;
    if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = undefined;
      if (this.stopped || this.listenGeneration !== generation) return;
      this.logger.debug('[reconnecting] %s:%d', this._registry_address.host, this._registry_address.port);
      void this.reconnectToRegistry().catch(() => {
        if (this.stopped || this.listenGeneration !== generation) return;
        this.scheduleRegistryRetry(generation);
      });
    }, 3000);
  }

  private canUsePubSub() {
    return !!this.port && !this.stopped;
  }

  private assertCanUsePubSub() {
    if (!this.canUsePubSub()) {
      throw new Error('Registry not found');
    }
  }

  private ensureRegistryReconnectScheduled() {
    if (!this.canUsePubSub()) return;
    const generation = this.listenGeneration;
    void this.reconnectToRegistry().catch(() => {
      if (this.stopped || this.listenGeneration !== generation) return;
      this.scheduleRegistryRetry(generation);
    });
  }

  private handleRegistrySyncFailure(registry: Client, err: any) {
    if (this.stopped) return;
    const generation = this.listenGeneration;
    this.logger.error(err);
    if (this.registry === registry) {
      this.registry = undefined;
      registry.dispose();
    }
    if (!this.stopped && this.listenGeneration === generation) {
      this.scheduleRegistryRetry(generation);
    }
  }

  private registryRequestOptions() {
    if (!Number.isFinite(this._registryLookupTimeoutMs) || this._registryLookupTimeoutMs <= 0) {
      return undefined;
    }
    return { timeout: this._registryLookupTimeoutMs };
  }

  private recordPublishedTopic(topic: string, payload: any) {
    this.pendingUnpublishes.delete(topic);
    const signature = stablePayloadSignature(payload);
    const previousSignature = this.publishedTopicSignatures.get(topic);
    const version = this.publishedTopics.has(topic) && previousSignature === signature
      ? this.publishedTopicVersions.get(topic) ?? ++this.publishIntentVersion
      : ++this.publishIntentVersion;
    this.publishedTopics.set(topic, payload);
    this.publishedTopicDirty.add(topic);
    this.publishedTopicVersions.set(topic, version);
    this.publishedTopicSignatures.set(topic, signature);
    return version;
  }

  private enqueueTopicSync(
    topic: string,
    operation: (registry: Client) => Promise<void>,
    options: { propagateError?: boolean } = {},
  ) {
    const previous = this.topicSyncs.get(topic) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      if (!this.canUsePubSub()) return;
      const registry = this.registry;
      if (!registry) {
        this.ensureRegistryReconnectScheduled();
        if (options.propagateError) throw new Error('Registry not found');
        return;
      }
      try {
        await operation(registry);
      } catch (err) {
        this.handleRegistrySyncFailure(registry, err);
        if (options.propagateError) throw err;
      }
    });
    const tracked = run.finally(() => {
      if (this.topicSyncs.get(topic) === tracked) {
        this.topicSyncs.delete(topic);
      }
    });
    this.topicSyncs.set(topic, tracked);
    return tracked;
  }

  private syncPublishedTopic(
    topic: string,
    options: {
      propagateError?: boolean;
      payload?: any;
      preserveRevision?: boolean;
      version?: number;
    } = {},
  ) {
    const hasPayload = Object.prototype.hasOwnProperty.call(options, 'payload');
    return this.enqueueTopicSync(topic, async (registry) => {
      if (!this.publishedTopics.has(topic)) return;
      const version = options.version ?? this.publishedTopicVersions.get(topic);
      const request: { topic: string; payload: any; revision?: number } = {
        topic,
        payload: hasPayload ? options.payload : this.publishedTopics.get(topic),
      };
      const preserveRevision = options.preserveRevision
        ?? (!this.publishedTopicDirty.has(topic) && this.publishedTopicRevisions.has(topic));
      if (preserveRevision && this.publishedTopicRevisions.has(topic)) {
        request.revision = this.publishedTopicRevisions.get(topic);
      }
      const revision = await registry.request<number>('/-/declare', request, this.registryRequestOptions());
      if (
        this.publishedTopics.has(topic) &&
        this.publishedTopicVersions.get(topic) === version &&
        Number.isFinite(revision)
      ) {
        this.publishedTopicRevisions.set(topic, revision);
        this.publishedTopicDirty.delete(topic);
      }
    }, options);
  }

  private syncUnpublishedTopic(topic: string, options: { propagateError?: boolean } = {}) {
    return this.enqueueTopicSync(topic, async (registry) => {
      await registry.request<number>('/-/undeclare', { topic }, this.registryRequestOptions());
    }, options);
  }

  private syncUnsubscribedTopic(topic: string, options: { propagateError?: boolean } = {}) {
    return this.enqueueTopicSync(topic, async (registry) => {
      await registry.request<number>('/-/unsubscribe', { topic }, this.registryRequestOptions());
    }, options);
  }

  private syncRestoredSubscription<T>(
    topic: string,
    callback: (data: T) => any,
    options: { propagateError?: boolean } = {},
  ) {
    return this.enqueueTopicSync(topic, async (registry) => {
      if (!this.topics.get(topic)?.has(callback)) return;
      await this.restoreSubscription(topic, callback, registry, true);
    }, options);
  }

  private async restoreSubscription<T>(
    topic: string,
    callback: (data: T) => any,
    registry: Client,
    isReconnect: boolean,
    requireLocal = true,
  ) {
    const replayBaseVersion = this.topicUpdateVersions.get(topic) ?? 0;
    const snapshot = await registry.request<TopicSnapshot<T>>(
      '/-/subscribe',
      { topic },
      this.registryRequestOptions(),
    );
    if (requireLocal && !this.topics.get(topic)?.has(callback)) return;
    if (!snapshot.hasData) return;
    if ((this.topicUpdateVersions.get(topic) ?? 0) !== replayBaseVersion) return;
    try {
      await Promise.resolve(callback(snapshot.payload));
    } catch (err) {
      if (!isReconnect) throw err;
      this.logger.error(err);
    }
  }

  private async rollbackLocalSubscription(topic: string, callback: (data: any) => any) {
    const callbacks = this.topics.get(topic);
    callbacks?.delete(callback);
    this.events.off('topic:' + topic, callback);
    if (callbacks?.size === 0) {
      this.topics.delete(topic);
      await this.syncUnsubscribedTopic(topic);
    }
  }

  private async reconnectToRegistry(): Promise<void> {
    if (this.stopped) return;
    const generation = this.listenGeneration;
    if (this.registryReconnectPromise && this.registryReconnectGeneration === generation) {
      return this.registryReconnectPromise;
    }
    this.registryReconnectGeneration = generation;
    const run = (async () => {
      const registry = await this.connect(this._registry_address.host, this._registry_address.port);
      if (this.stopped || this.listenGeneration !== generation) {
        registry.dispose();
        return;
      }
      registry.events.once('disconnect', () => {
        if (this.registry !== registry) return;
        this.registry = undefined;
        if (this.stopped || this.listenGeneration !== generation) return;
        void this.reconnectToRegistry().catch(() => {
          if (this.stopped || this.listenGeneration !== generation) return;
          this.scheduleRegistryRetry(generation);
        });
      });
      this.registry = registry;
      for (const topic of [...this.pendingUnpublishes]) {
        await this.syncUnpublishedTopic(topic, { propagateError: true });
        if (!this.publishedTopics.has(topic)) this.pendingUnpublishes.delete(topic);
      }
      // 重新声明所有仍处于发布状态的 topic
      for (const topic of [...this.publishedTopics.keys()]) {
        if (this.stopped || this.listenGeneration !== generation) {
          registry.dispose();
          return;
        }
        if (!this.publishedTopics.has(topic)) continue;
        await this.syncPublishedTopic(topic, { propagateError: true });
      }
      // 重新订阅所有 topic
      for (const [topic, callbacks] of [...this.topics]) {
        for (const callback of [...callbacks]) {
          if (this.stopped || this.listenGeneration !== generation) {
            registry.dispose();
            return;
          }
          if (!this.topics.get(topic)?.has(callback)) continue;
          await this.syncRestoredSubscription(topic, callback, { propagateError: true });
        }
      }
      this.logger.debug('[reconnected] %s:%d', this._registry_address.host, this._registry_address.port);
    })();
    const tracked = run.finally(() => {
      if (this.registryReconnectPromise === tracked) {
        this.registryReconnectPromise = undefined;
        this.registryReconnectGeneration = 0;
      }
    });
    this.registryReconnectPromise = tracked;

    return tracked;
  }

  private peerKey(host: string, port: number) {
    return `${host}:${port}`;
  }

  private getPeerStates(ns: string, create = false) {
    let states = this.circuitBreakers.get(ns);
    if (!states && create) {
      states = new Map();
      this.circuitBreakers.set(ns, states);
    }
    return states;
  }

  private getOrCreatePeerState(ns: string, host: string, port: number) {
    const states = this.getPeerStates(ns, true)!;
    const key = this.peerKey(host, port);
    let state = states.get(key);
    if (!state) {
      state = {
        status: 'closed',
        failures: 0,
        successes: 0,
        openedAt: 0,
        nextAttemptAt: 0,
        cooldownMs: this._circuitBreaker.cooldownMs,
        lastFailureAt: 0,
        halfOpenInFlight: 0,
      };
      states.set(key, state);
    }
    return state;
  }

  private deletePeerState(ns: string, key: string) {
    const states = this.circuitBreakers.get(ns);
    if (!states) return;
    states.delete(key);
    if (states.size === 0) this.circuitBreakers.delete(ns);
  }

  private openCircuit(state: CircuitBreakerPeerState, cooldownMs: number) {
    const now = Date.now();
    state.status = 'open';
    state.successes = 0;
    state.openedAt = now;
    state.lastFailureAt = now;
    state.cooldownMs = Math.min(cooldownMs, this._circuitBreaker.maxCooldownMs);
    state.nextAttemptAt = now + state.cooldownMs;
    state.halfOpenInFlight = 0;
  }

  private acquireCircuitProbe(ns: string, host: string, port: number) {
    const key = this.peerKey(host, port);
    const state = this.circuitBreakers.get(ns)?.get(key);
    if (state?.status === 'open') {
      return {
        acquired: false,
        wasHalfOpen: false,
        cooldownMs: state.cooldownMs,
        release: () => { },
      };
    }
    if (state?.status !== 'half-open') {
      return {
        acquired: true,
        wasHalfOpen: false,
        cooldownMs: this._circuitBreaker.cooldownMs,
        release: () => { },
      };
    }
    if (state.halfOpenInFlight >= this._circuitBreaker.halfOpenMaxProbes) {
      return {
        acquired: false,
        wasHalfOpen: true,
        cooldownMs: state.cooldownMs,
        release: () => { },
      };
    }
    state.halfOpenInFlight++;
    let released = false;
    return {
      acquired: true,
      wasHalfOpen: true,
      cooldownMs: state.cooldownMs,
      release: () => {
        if (released) return;
        released = true;
        const current = this.circuitBreakers.get(ns)?.get(key);
        if (current?.status === 'half-open' && current.halfOpenInFlight > 0) {
          current.halfOpenInFlight--;
        }
      },
    };
  }

  private shouldRecordCircuitFailure(err: unknown) {
    try {
      return this._circuitBreaker.shouldRecordFailure(err);
    } catch (hookErr) {
      this.logger.error(hookErr);
      return true;
    }
  }

  private shouldRetryCircuitFailure(err: unknown) {
    try {
      return this._circuitBreaker.shouldRetry(err);
    } catch (hookErr) {
      this.logger.error(hookErr);
      return false;
    }
  }

  private recordSuccess(ns: string, host: string, port: number, probe: CircuitBreakerProbe) {
    const key = this.peerKey(host, port);
    const state = this.circuitBreakers.get(ns)?.get(key);
    if (!state) return;
    if (probe.wasHalfOpen) {
      if (state.status !== 'half-open') return;
      state.failures = 0;
      state.successes++;
      if (state.successes < this._circuitBreaker.successThreshold) return;
    } else if (state.status !== 'closed') {
      return;
    }
    this.deletePeerState(ns, key);
  }

  private recordFailure(ns: string, host: string, port: number, err: unknown, probe: CircuitBreakerProbe) {
    if (!this.shouldRecordCircuitFailure(err)) return;
    const now = Date.now();
    const key = this.peerKey(host, port);

    if (probe.wasHalfOpen) {
      const state = this.circuitBreakers.get(ns)?.get(key);
      if (state?.status !== 'half-open') return;
      state.failures = this._circuitBreaker.failureThreshold;
      state.successes = 0;
      this.openCircuit(state, Math.max(state.cooldownMs, probe.cooldownMs) * 2);
      return;
    }

    const state = this.getOrCreatePeerState(ns, host, port);
    if (state.status !== 'closed') return;
    state.successes = 0;

    if (state.lastFailureAt > 0 && now - state.lastFailureAt >= this._circuitBreaker.failureWindowMs) {
      state.failures = 0;
    }

    state.lastFailureAt = now;
    state.failures++;
    if (state.failures >= this._circuitBreaker.failureThreshold) {
      this.openCircuit(state, this._circuitBreaker.cooldownMs);
    }
  }

  private getActiveCircuitExcludes(ns: string): {
    keys: string[];
    hasProbeLimitedPeer: boolean;
  } {
    const states = this.circuitBreakers.get(ns);
    if (!states) return { keys: [], hasProbeLimitedPeer: false };
    const now = Date.now();
    const keys: string[] = [];
    let hasProbeLimitedPeer = false;
    for (const [key, state] of states) {
      if (
        state.status === 'closed' &&
        state.lastFailureAt > 0 &&
        now - state.lastFailureAt >= this._circuitBreaker.failureWindowMs
      ) {
        states.delete(key);
        continue;
      }

      if (state.status === 'open') {
        if (now >= state.nextAttemptAt) {
          state.status = 'half-open';
          state.successes = 0;
          state.halfOpenInFlight = 0;
        } else {
          keys.push(key);
        }
      }

      if (state.status === 'half-open' && state.halfOpenInFlight >= this._circuitBreaker.halfOpenMaxProbes) {
        keys.push(key);
        hasProbeLimitedPeer = true;
      }
    }
    if (states.size === 0) this.circuitBreakers.delete(ns);
    return { keys, hasProbeLimitedPeer };
  }

  private getActiveExcludes(ns: string): string[] {
    return this.getActiveCircuitExcludes(ns).keys;
  }

  private trackCircuitStream(
    ns: string,
    host: string,
    port: number,
    probe: CircuitBreakerProbe,
    readable: import('stream').Readable,
  ) {
    let settled = false;
    const settle = (status: 'success' | 'failure' | 'neutral', err?: unknown) => {
      if (settled) return;
      settled = true;
      if (status === 'failure') {
        this.recordFailure(ns, host, port, err, probe);
      } else if (status === 'success') {
        this.recordSuccess(ns, host, port, probe);
      }
      probe.release();
    };

    readable.once('error', err => settle('failure', err));
    readable.once('end', () => settle('success'));
    readable.once('close', () => settle('neutral'));
    return readable;
  }

  private async selectCircuitClient(namespace: string, allowExcludedCachedFallback = true) {
    const { keys: exclude, hasProbeLimitedPeer } = this.getActiveCircuitExcludes(namespace);
    try {
      return await this.resolveClient(namespace, exclude, {
        allowExcludedCachedFallback: allowExcludedCachedFallback && !hasProbeLimitedPeer,
      });
    } catch (err) {
      if (!allowExcludedCachedFallback || hasProbeLimitedPeer) throw err;
      this.circuitBreakers.delete(namespace);
      return this.get(namespace);
    }
  }

  private async selectCircuitProbe(namespace: string, allowCircuitReset: boolean) {
    let client = await this.selectCircuitClient(namespace, allowCircuitReset);
    let probe = this.acquireCircuitProbe(namespace, client.host, client.port);
    if (probe.acquired) return { client, probe };
    let blockedByHalfOpenProbe = probe.wasHalfOpen;
    let resetClient: Client | undefined = probe.wasHalfOpen ? undefined : client;

    try {
      client = await this.selectCircuitClient(namespace, false);
      probe = this.acquireCircuitProbe(namespace, client.host, client.port);
      if (probe.acquired) return { client, probe };
      blockedByHalfOpenProbe ||= probe.wasHalfOpen;
      if (!probe.wasHalfOpen) resetClient = client;
    } catch (err) {
      if (!allowCircuitReset) throw err;
    }

    if (!allowCircuitReset || blockedByHalfOpenProbe) {
      throw new Error(`Circuit breaker probe unavailable for ${namespace}`);
    }

    this.circuitBreakers.delete(namespace);
    // Preserve a cached client selected before the reset. A registry failure can
    // clear namespace cache while the peer connection itself is still usable.
    client = resetClient ?? await this.get(namespace);
    probe = this.acquireCircuitProbe(namespace, client.host, client.port);
    if (!probe.acquired) {
      throw new Error(`Circuit breaker probe unavailable for ${namespace}`);
    }
    return { client, probe };
  }

  private async findFromRegistry(namespace: string, exclude?: string[]) {
    if (!this.registry) throw new Error('Registry not found');
    const promise = this.registry.request<{ host: string, port: number } | undefined>('/-/find', { namespace, exclude });
    return await withTimeout(promise, this._registryLookupTimeoutMs, 'Registry /-/find');
  }

  public get(namespace: string, exclude?: string[]) {
    return this.resolveClient(namespace, exclude);
  }

  protected resolveClient(namespace: string, exclude?: string[], options: RegistryLookupOptions = {}) {
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
        }).catch(e => {
          // Registry unavailable but previously cached client still valid -> degrade
          const cachedKey = `${cachedHost}:${cachedPort}`;
          const cachedExcluded = exclude?.includes(cachedKey);
          const allowCachedFallback = options.allowExcludedCachedFallback ?? true;
          if (cachedHost && this.clients.has(cachedKey) && (allowCachedFallback || !cachedExcluded)) {
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
    let remainingRetries = retries;
    let retrySourceError: unknown;
    let hasRetrySourceError = false;

    for (;;) {
      let selected: { client: Client; probe: CircuitBreakerProbe };
      try {
        selected = await this.selectCircuitProbe(namespace, !hasRetrySourceError);
      } catch (err) {
        if (hasRetrySourceError) throw retrySourceError;
        throw err;
      }
      const { client, probe } = selected;
      try {
        const result = await client.request<T>(url, data, {
          timeout: timeout ?? this._requestTimeoutMs,
          signal,
        });
        this.recordSuccess(namespace, client.host, client.port, probe);
        return result;
      } catch (err) {
        this.recordFailure(namespace, client.host, client.port, err, probe);
        if (remainingRetries > 0 && this.shouldRetryCircuitFailure(err)) {
          retrySourceError = err;
          hasRetrySourceError = true;
          remainingRetries--;
          continue;
        }
        throw err;
      } finally {
        probe.release();
      }
    }
  }

  public async stream(
    namespace: string,
    url: string,
    data: any,
    options?: ClientStreamOptions & { retries?: number },
  ): Promise<import('stream').Readable> {
    const { signal, retries = 1, timeout, idleTimeout, window } = options || {};
    let remainingRetries = retries;
    let retrySourceError: unknown;
    let hasRetrySourceError = false;

    for (;;) {
      let selected: { client: Client; probe: CircuitBreakerProbe };
      try {
        selected = await this.selectCircuitProbe(namespace, !hasRetrySourceError);
      } catch (err) {
        if (hasRetrySourceError) throw retrySourceError;
        throw err;
      }
      const { client, probe } = selected;
      try {
        const readable = client.stream(url, data, { signal, timeout, idleTimeout, window });
        return this.trackCircuitStream(namespace, client.host, client.port, probe, readable);
      } catch (err) {
        this.recordFailure(namespace, client.host, client.port, err, probe);
        probe.release();
        if (remainingRetries > 0 && this.shouldRetryCircuitFailure(err)) {
          retrySourceError = err;
          hasRetrySourceError = true;
          remainingRetries--;
          continue;
        }
        throw err;
      }
    }
  }

  /** Opens a stream against one exact service instance without registry selection. */
  public async streamPeer(
    address: RegistryAddress,
    url: string,
    data: any,
    options?: ClientStreamOptions,
  ): Promise<import('stream').Readable> {
    assertValidRegistrySocket('peer address', address.host, address.port);
    if (options?.timeout !== undefined && (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 2_147_483_647)) {
      throw new TypeError('Stream timeout must be a positive safe integer not exceeding 2147483647');
    }
    const startedAt = Date.now();
    const client = await this.connect(address.host, address.port, options?.timeout, options?.signal);
    const timeout = options?.timeout === undefined
      ? undefined
      : Math.max(1, options.timeout - (Date.now() - startedAt));
    return client.stream(url, data, { ...options, timeout });
  }

  public async publish<T = any>(topic: string, data: T) {
    this.assertCanUsePubSub();
    const snapshot = createPubSubPayloadSnapshot(topic, data);
    const version = this.recordPublishedTopic(topic, snapshot);
    await this.syncPublishedTopic(topic, { payload: snapshot, preserveRevision: false, version });
    let refVersion = version;
    const ref = {
      update: async (payload: T) => {
        this.assertCanUsePubSub();
        if (this.publishedTopicVersions.get(topic) !== refVersion) return ref;
        const snapshot = createPubSubPayloadSnapshot(topic, payload);
        const version = this.recordPublishedTopic(topic, snapshot);
        refVersion = version;
        await this.syncPublishedTopic(topic, { payload: snapshot, preserveRevision: false, version });
        return ref;
      },
      unpublish: async () => {
        await this.unpublish(topic, refVersion);
        return ref;
      }
    }
    return ref;
  }

  /** Removes a publication intent and retries its Registry tombstone until acknowledged. */
  public async unpublish(topic: string, expectedVersion?: number) {
    const currentVersion = this.publishedTopicVersions.get(topic);
    if (expectedVersion !== undefined && currentVersion !== expectedVersion && !this.pendingUnpublishes.has(topic)) return;
    if (expectedVersion === undefined || currentVersion === expectedVersion) {
      this.publishedTopics.delete(topic);
      this.publishedTopicRevisions.delete(topic);
      this.publishedTopicDirty.delete(topic);
      this.publishedTopicVersions.delete(topic);
      this.publishedTopicSignatures.delete(topic);
      this.pendingUnpublishes.add(topic);
    }
    if (!this.canUsePubSub()) {
      this.pendingUnpublishes.delete(topic);
      return;
    }
    if (!this.registry) {
      this.ensureRegistryReconnectScheduled();
      return;
    }
    if (!this.pendingUnpublishes.has(topic)) return;
    await this.syncUnpublishedTopic(topic, { propagateError: true });
    if (!this.publishedTopics.has(topic)) this.pendingUnpublishes.delete(topic);
  }

  /** Reads Registry topic metadata without creating a pub/sub subscription. */
  public async listRegistryTopics(prefix?: string, options?: { signal?: AbortSignal }): Promise<RegistryTopicSummary[]> {
    const registry = this.registry;
    if (!registry) {
      this.ensureRegistryReconnectScheduled();
      throw new Error('Registry is not connected');
    }
    const result = await registry.request<RegistryTopicsResult>(
      '/-/topics',
      prefix === undefined ? {} : { prefix },
      { ...this.registryRequestOptions(), signal: options?.signal },
    );
    return structuredClone(result.topics);
  }

  /** Reads current topic payloads in one Registry round trip. */
  public async listRegistryTopicSnapshots(prefix?: string, options?: { signal?: AbortSignal }): Promise<RegistryTopicSnapshotsResult['topics']> {
    const registry = this.registry;
    if (!registry) {
      this.ensureRegistryReconnectScheduled();
      throw new Error('Registry is not connected');
    }
    const result = await registry.request<RegistryTopicSnapshotsResult>(
      '/-/topic/snapshots',
      prefix === undefined ? {} : { prefix },
      { ...this.registryRequestOptions(), signal: options?.signal },
    );
    return structuredClone(result.topics);
  }

  /** Reads one retained/current Registry topic payload without subscribing to it. */
  public async getRegistryTopic<T = unknown>(topic: string, options?: { signal?: AbortSignal }): Promise<RegistryTopicSnapshot & { payload: T } | undefined> {
    if (typeof topic !== 'string' || topic.length === 0) {
      throw new TypeError('Registry topic must not be empty');
    }
    const registry = this.registry;
    if (!registry) {
      this.ensureRegistryReconnectScheduled();
      throw new Error('Registry is not connected');
    }
    const snapshot = await registry.request<RegistryTopicSnapshot & { payload: T } | undefined>(
      '/-/topic/get',
      { topic },
      { ...this.registryRequestOptions(), signal: options?.signal },
    );
    return snapshot === undefined ? undefined : structuredClone(snapshot);
  }

  /**
   * 对同一 topic 可多次 subscribe，各自独立回调。
   * 传入同一个 callback 引用第二次调用时幂等返回 unsubscribe，不重复注册。
   */
  public async subscribe<T = any>(topic: string, callback: (data: T) => any, isReconnect = false) {
    this.assertCanUsePubSub();
    const fallback = async () => {
      if (this.topics.has(topic)) {
        const callbacks = this.topics.get(topic)!;
        callbacks.delete(callback);
        this.events.off('topic:' + topic, callback);
        if (callbacks.size === 0) {
          this.topics.delete(topic);
          await this.syncUnsubscribedTopic(topic);
        }
      }
    }
    let localRegistered = false;
    if (isReconnect) {
      if (!this.registry) {
        this.ensureRegistryReconnectScheduled();
        return fallback;
      }
      await this.restoreSubscription(topic, callback, this.registry, true, false);
      return fallback;
    }
    if (!isReconnect) {
      // 预分配 Set 必须在 await 之前；空 Set 残留无害，会在 unsubscribe / shutdown 时清理
      if (!this.topics.has(topic)) {
        this.topics.set(topic, new Set());
      }
      // 同一个 callback 引用已注册，幂等返回 unsubscribe，不重复发起订阅
      if (this.topics.get(topic)!.has(callback)) return fallback;
      this.topics.get(topic)!.add(callback);
      this.events.on('topic:' + topic, callback);
      localRegistered = true;
    }
    const registry = this.registry;
    if (!registry) {
      this.ensureRegistryReconnectScheduled();
      return fallback;
    }
    const replayBaseVersion = this.topicUpdateVersions.get(topic) ?? 0;
    let snapshot: TopicSnapshot<T> | undefined;
    let synced = false;
    await this.enqueueTopicSync(topic, async (registry) => {
      if (!this.topics.get(topic)?.has(callback)) return;
      snapshot = await registry.request<TopicSnapshot<T>>(
        '/-/subscribe',
        { topic },
        this.registryRequestOptions(),
      );
      synced = true;
    });
    if (!synced || !snapshot) {
      return fallback;
    }
    try {
      if (
        this.topics.get(topic)?.has(callback) &&
        snapshot.hasData &&
        (this.topicUpdateVersions.get(topic) ?? 0) === replayBaseVersion
      ) {
        await Promise.resolve(callback(snapshot.payload));
      }
    } catch (err) {
      if (localRegistered) await this.rollbackLocalSubscription(topic, callback);
      throw err;
    }
    return fallback;
  }
}
