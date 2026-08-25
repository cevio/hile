import { Server, type MicroServerProps } from './server';
import { Client } from './client';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, watch } from 'node:fs';
import YAML from 'yaml';
export interface RegistryFindData {
  namespace: string;
  exclude?: string[];
}

export interface RegistryAddress {
  host: string;
  port: number;
}

export interface RegistryNamespaceSnapshot {
  namespace: string;
  peerCount: number;
  peers: RegistryAddress[];
}

export interface RegistryNamespacesResult {
  namespaces: RegistryNamespaceSnapshot[];
}

export type RegistryNamespacePeersData = RegistryFindData;

export interface RegistryNamespacePeersResult {
  namespace: string;
  peers: RegistryAddress[];
}

export interface RegistryStatusSnapshot {
  status: 'ok';
  startedAt: number;
  uptime: number;
  clientCount: number;
  namespaceCount: number;
  topicCount: number;
  configNamespaceCount: number;
}

export interface RegistryTopicsData {
  prefix?: string;
}

export interface RegistryTopicSummary {
  topic: string;
  publisherCount: number;
  subscriberCount: number;
  hasData: boolean;
  retained: boolean;
}

export interface RegistryTopicsResult {
  topics: RegistryTopicSummary[];
}

export interface RegistryTopicSnapshotsResult {
  topics: Array<RegistryTopicSnapshot & { publishers: RegistryAddress[] }>;
}

export interface RegistryTopicGetData {
  topic: string;
}

export interface RegistryTopicSnapshot extends RegistryTopicSummary {
  payload: any;
}

export interface RegistryConfigSummary {
  namespace: string;
  keys: string[];
}

export interface RegistryConfigsResult {
  configs: RegistryConfigSummary[];
}

export interface RegistryConfigGetData {
  namespace: string;
  key?: string;
}

export type RegistryConfigGetResult =
  | { namespace: string; hasConfig: true; config: any }
  | { namespace: string; hasConfig: false }
  | { namespace: string; key: string; hasValue: true; value: any }
  | { namespace: string; key: string; hasValue: false };

/** 将 `host:port` 或 `[ipv6]:port` 形式的 key 解析为地址（端口取最后一个 `:` 之后） */
export function parseAddressKey(key: string): RegistryAddress | undefined {
  const i = key.lastIndexOf(':');
  if (i <= 0 || i >= key.length - 1) return undefined;
  const host = key.slice(0, i);
  const port = Number(key.slice(i + 1));
  if (
    !host ||
    !Number.isFinite(port) ||
    port !== Math.trunc(port) ||
    port < 1 ||
    port > 65535
  ) {
    return undefined;
  }
  return { host, port };
}

export function selectRandomRegistryAddress(keys: Iterable<string>): RegistryAddress | undefined {
  const addresses = Array.from(keys)
    .map(parseAddressKey)
    .filter((a): a is RegistryAddress => a !== undefined);

  if (addresses.length === 0) return;

  const index = Math.floor(Math.random() * addresses.length);
  return addresses[index];
}

function compareRegistryAddress(a: RegistryAddress, b: RegistryAddress) {
  const byHost = a.host.localeCompare(b.host);
  if (byHost !== 0) return byHost;
  return a.port - b.port;
}

function registryAddressesFromKeys(keys: Iterable<string>, exclude?: string[]) {
  const excludeSet = exclude?.length ? new Set(exclude) : undefined;
  return Array.from(keys)
    .filter(key => !excludeSet?.has(key))
    .map(parseAddressKey)
    .filter((address): address is RegistryAddress => address !== undefined)
    .sort(compareRegistryAddress);
}

function cloneRegistryValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export function getRegistryConfigsDir(): string {
  return resolve(homedir(), '.registry', 'configs');
}

export function namespaceToConfigFile(ns: string): string {
  return join(getRegistryConfigsDir(), `${ns}.config.yaml`);
}

export function parseConfigFilename(filename: string): string | null {
  if (!filename.endsWith('.config.yaml')) return null;
  return filename.slice(0, -'.config.yaml'.length);
}

type TopicEntry = {
  publishers: Set<string>;
  publisherPayloads: Map<string, {
    data: any;
    signature: string;
    revision: number;
  }>;
  subscribers: Set<string>;
  data: any;
  hasData: boolean;
  signature?: string;
  retained: boolean;
};

type TopicSnapshot = {
  hasData: boolean;
  payload: any;
};

function createTopicEntry(data?: any, hasData = false, retained = false): TopicEntry {
  return {
    publishers: new Set(),
    publisherPayloads: new Map(),
    subscribers: new Set(),
    data,
    hasData,
    signature: hasData ? stableSignature(data) : undefined,
    retained,
  };
}

function stableSignature(value: any): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return `string:${JSON.stringify(value)}`;
  if (type === 'number') return `number:${String(value)}`;
  if (type === 'boolean') return `boolean:${String(value)}`;
  if (type === 'bigint') return `bigint:${String(value)}`;
  if (Array.isArray(value)) {
    return `array:[${value.map(stableSignature).join(',')}]`;
  }
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return `object:{${keys.map(key => `${JSON.stringify(key)}:${stableSignature(value[key])}`).join(',')}}`;
  }
  return `${type}:${String(value)}`;
}

export class Registry extends Server {
  private readonly namespaces = new Map<string, Set<string>>();
  private readonly workspace: string;
  private readonly configFileSuffix = '.config.yaml';
  private readonly configs = new Map<string, any>();
  private readonly fallbacks = new Set<() => void>();
  private readonly topics = new Map<string, TopicEntry>();
  private topicRevision = 0;
  private readonly startedAt = Date.now();

  constructor(props: MicroServerProps = {}) {
    const workspace = resolve(homedir(), '.registry');
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }

    super('registry', props);
    this.workspace = workspace;
    this.events.on('connect', (client: Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      const namespace = extras.join('/');
      if (!this.namespaces.has(namespace)) {
        this.namespaces.set(namespace, new Set());
      }
      this.namespaces.get(namespace)!.add(key);
      this.logger.debug('[connect] %s/%s', key, namespace);
    });
    this.events.on('disconnect', (client: Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      // 清理 topic 中的关联
      for (const [topic, entry] of [...this.topics]) {
        if (entry.publishers.has(key)) {
          entry.publishers.delete(key);
          entry.publisherPayloads.delete(key);
          this.restoreTopicDataFromRemainingPublishers(topic, entry);
          this.logger.debug('[delete publisher] %s', key);
        }
        if (entry.subscribers.has(key)) {
          entry.subscribers.delete(key);
          this.logger.debug('[delete subscriber] %s', key);
        }
        this.cleanupTopicIfUnused(topic, entry);
      }
      // 清理 namespace 中的关联
      const namespace = extras.join('/');
      if (this.namespaces.has(namespace)) {
        const keys = this.namespaces.get(namespace)!;
        if (keys.has(key)) {
          keys.delete(key);
          this.logger.debug('[disconnect] %s/%s', key, namespace);
          if (keys.size === 0) {
            this.namespaces.delete(namespace);
            this.logger.debug('[delete namespace] %s', namespace);
          }
        }
      }
    });
    this.registerFindApplication();
    this.registerDeclare();
    this.registerUndeclare();
    this.registerSubscribe();
    this.registerUnsubscribe();
    this.registerReceiveTopicUpdate();
    this.registerReadApis();
  }

  private createNamespaceSnapshot(namespace: string, keys: Set<string>): RegistryNamespaceSnapshot {
    const peers = registryAddressesFromKeys(keys);
    return {
      namespace,
      peerCount: peers.length,
      peers,
    };
  }

  private createTopicSummary(topic: string, entry: TopicEntry): RegistryTopicSummary {
    return {
      topic,
      publisherCount: entry.publishers.size,
      subscriberCount: entry.subscribers.size,
      hasData: entry.hasData,
      retained: entry.retained,
    };
  }

  private createTopicSnapshot(topic: string, entry: TopicEntry): RegistryTopicSnapshot {
    return {
      ...this.createTopicSummary(topic, entry),
      payload: cloneRegistryValue(entry.data),
    };
  }

  private listTopicSummaries(prefix?: string) {
    return this.listTopicEntries(prefix).map(([topic, entry]) => this.createTopicSummary(topic, entry));
  }

  private listTopicEntries(prefix?: string) {
    const hasPrefix = typeof prefix === 'string' && prefix.length > 0;
    return [...this.topics.entries()]
      .filter(([topic]) => !hasPrefix || topic.startsWith(prefix!))
      .sort(([a], [b]) => a.localeCompare(b));
  }

  private registerReadApis() {
    this.fallbacks.add(this.register<{}, {}>('/-/namespaces', async (): Promise<RegistryNamespacesResult> => {
      const namespaces = [...this.namespaces.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([namespace, keys]) => this.createNamespaceSnapshot(namespace, keys));
      return { namespaces };
    }));
    this.fallbacks.add(this.register<RegistryNamespacePeersData, {}>('/-/namespace/peers', async ({ data }): Promise<RegistryNamespacePeersResult> => {
      const namespace = typeof data?.namespace === 'string' ? data.namespace : '';
      const keys = this.namespaces.get(namespace);
      return {
        namespace,
        peers: keys ? registryAddressesFromKeys(keys, data.exclude) : [],
      };
    }));
    this.fallbacks.add(this.register<{}, {}>('/-/registry/status', async (): Promise<RegistryStatusSnapshot> => ({
      status: 'ok',
      startedAt: this.startedAt,
      uptime: Date.now() - this.startedAt,
      clientCount: this.clients.size,
      namespaceCount: this.namespaces.size,
      topicCount: this.topics.size,
      configNamespaceCount: this.configs.size,
    })));
    this.fallbacks.add(this.register<RegistryTopicsData, {}>('/-/topics', async ({ data }): Promise<RegistryTopicsResult> => ({
      topics: this.listTopicSummaries(data?.prefix),
    })));
    this.fallbacks.add(this.register<RegistryTopicsData, {}>('/-/topic/snapshots', async ({ data }): Promise<RegistryTopicSnapshotsResult> => ({
      topics: this.listTopicEntries(data?.prefix).map(([topic, entry]) => ({
        ...this.createTopicSnapshot(topic, entry),
        publishers: registryAddressesFromKeys(entry.publishers),
      })),
    })));
    this.fallbacks.add(this.register<RegistryTopicGetData, {}>('/-/topic/get', async ({ data }) => {
      if (typeof data?.topic !== 'string') return;
      const entry = this.topics.get(data.topic);
      if (!entry) return;
      return this.createTopicSnapshot(data.topic, entry);
    }));
    this.fallbacks.add(this.register<{}, {}>('/-/configs', async (): Promise<RegistryConfigsResult> => {
      const configs = [...this.configs.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([namespace, config]) => ({
          namespace,
          keys: Object.keys(config).sort(),
        }));
      return { configs };
    }));
    this.fallbacks.add(this.register<RegistryConfigGetData, {}>('/-/config/get', async ({ data }): Promise<RegistryConfigGetResult> => {
      const namespace = typeof data?.namespace === 'string' ? data.namespace : '';
      const config = this.configs.get(namespace);
      if (typeof data?.key === 'string') {
        if (config && Object.prototype.hasOwnProperty.call(config, data.key)) {
          return {
            namespace,
            key: data.key,
            hasValue: true,
            value: cloneRegistryValue(config[data.key]),
          };
        }
        return {
          namespace,
          key: data.key,
          hasValue: false,
        };
      }
      if (!config) {
        return {
          namespace,
          hasConfig: false,
        };
      }
      return {
        namespace,
        hasConfig: true,
        config: cloneRegistryValue(config),
      };
    }));
  }

  private cleanupTopicIfUnused(topic: string, entry = this.topics.get(topic)) {
    if (!entry) return;
    if (entry.retained) return;
    if (entry.publishers.size === 0 && entry.subscribers.size === 0) {
      this.topics.delete(topic);
      this.logger.debug('[delete topic] %s', topic);
    }
  }

  private clearTopicData(entry: TopicEntry) {
    if (entry.retained) return;
    entry.data = undefined;
    entry.hasData = false;
    entry.signature = undefined;
  }

  private rememberPublisherPayload(entry: TopicEntry, key: string, payload: any, revision?: number) {
    const nextRevision = Number.isFinite(revision) && revision! > 0 ? revision! : ++this.topicRevision;
    this.topicRevision = Math.max(this.topicRevision, nextRevision);
    entry.publisherPayloads.set(key, {
      data: payload,
      signature: stableSignature(payload),
      revision: nextRevision,
    });
    return nextRevision;
  }

  private setTopicData(entry: TopicEntry, payload: any) {
    const signature = stableSignature(payload);
    const changed = !entry.hasData || entry.signature !== signature;
    entry.data = payload;
    entry.hasData = true;
    entry.signature = signature;
    return changed;
  }

  private restoreTopicDataFromRemainingPublishers(topic: string, entry: TopicEntry) {
    if (entry.retained) return;
    let latest: { data: any; signature: string; revision: number } | undefined;
    for (const payload of entry.publisherPayloads.values()) {
      if (!latest || payload.revision > latest.revision) {
        latest = payload;
      }
    }
    if (!latest) {
      this.clearTopicData(entry);
      return;
    }
    const changed = !entry.hasData || entry.signature !== latest.signature;
    entry.data = latest.data;
    entry.hasData = true;
    entry.signature = latest.signature;
    if (changed) {
      this.notifySubscribers(topic, latest.data, entry);
    }
  }

  public watchEnvFile() {
    const configFile = resolve(this.workspace, 'configs');
    if (!existsSync(configFile)) {
      mkdirSync(configFile, { recursive: true });
    }
    const configFiles = readdirSync(configFile).filter(filename => filename.endsWith(this.configFileSuffix));
    for (const filename of configFiles) {
      try {
        const config = YAML.parse(readFileSync(resolve(configFile, filename), 'utf8'));
        if (typeof config !== 'object' || config === null) continue;
        const namespace = parseConfigFilename(filename)!;
        this.configs.set(namespace, config);
        const keys = Object.keys(config);
        for (const key of keys) {
          const _key = `registry:${namespace}/${key}`;
          if (!this.topics.has(_key)) {
            this.topics.set(_key, createTopicEntry(config[key], true, true));
          } else {
            this.topics.get(_key)!.retained = true;
          }
          this.publish(_key, config[key]);
        }
      } catch { }
    }
    return watch(configFile, (_, filename) => {
      if (!filename?.endsWith(this.configFileSuffix)) return;
      const fullPath = resolve(configFile, filename);
      if (!existsSync(fullPath)) {
        const namespace = parseConfigFilename(filename)!;
        this.configs.delete(namespace);
        return;
      }
      try {
        const config = YAML.parse(readFileSync(fullPath, 'utf8'));
        if (typeof config !== 'object' || config === null) return;
        const namespace = parseConfigFilename(filename)!;
        this.configs.set(namespace, config);
        const keys = Object.keys(config);
        // 只加不减
        for (const key of keys) {
          const _key = `registry:${namespace}/${key}`;
          if (!this.topics.has(_key)) {
            this.topics.set(_key, createTopicEntry(config[key], true, true));
          } else {
            this.topics.get(_key)!.retained = true;
          }
          this.publish(_key, config[key]);
        }
      } catch { /* vim 替换文件时的中间态读错误，忽略 */ }
    });
  }

  public async listen(port: number = 0) {
    const registry_port = process.env.REGISTRY_PORT ? Number(process.env.REGISTRY_PORT) : 0;
    const _port = port || registry_port;
    if (!_port || _port <= 0) throw new Error('Unable to resolve registry port: pass `port` in constructor options, or ensure process.env.REGISTRY_PORT is set.');
    const teardown = await super.listen(_port);
    const watcher = this.watchEnvFile();

    return async () => {
      if (watcher) watcher.close();
      await teardown();
    };
  }

  private registerFindApplication() {
    this.fallbacks.add(this.register<RegistryFindData, { client: Client }>('/-/find', async ({ data }) => {
      const namespace = data.namespace;
      let keys = this.namespaces.get(namespace);
      if (!keys) return;

      if (data.exclude?.length) {
        const excludeSet = new Set(data.exclude);
        const filtered = [...keys].filter(k => !excludeSet.has(k));
        if (filtered.length === 0) return;
        keys = new Set(filtered);
      }

      return selectRandomRegistryAddress(keys);
    }));
  }

  private registerDeclare() {
    this.fallbacks.add(this.register<{ topic: string, payload: any, revision?: number }, { client: Client }>('/-/declare', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) {
        this.topics.set(data.topic, createTopicEntry());
      }
      const entry = this.topics.get(data.topic)!;
      const publishers = entry.publishers;
      publishers.add(key);
      const revision = this.publish(data.topic, data.payload, key, data.revision);
      this.logger.debug('[declare] %s/%s', key, data.topic);
      return revision;
    }))
  }

  private registerUndeclare() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/undeclare', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) return 0;
      const entry = this.topics.get(data.topic)!;
      const publishers = entry.publishers;
      const i = publishers.size;
      if (publishers.has(key)) {
        publishers.delete(key);
        entry.publisherPayloads.delete(key);
        this.restoreTopicDataFromRemainingPublishers(data.topic, entry);
        this.logger.debug('[undeclare] %s/%s', key, data.topic);
        this.cleanupTopicIfUnused(data.topic, entry);
      }
      return i - publishers.size;
    }))
  }

  private registerSubscribe() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/subscribe', async ({ data, client }): Promise<TopicSnapshot> => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) {
        this.topics.set(data.topic, createTopicEntry());
      }
      const entry = this.topics.get(data.topic)!;
      const subscribers = entry.subscribers;
      subscribers.add(key);
      this.logger.debug('[subscribe] %s/%s', key, data.topic);
      return { hasData: entry.hasData, payload: entry.data };
    }))
  }

  private registerUnsubscribe() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/unsubscribe', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) return 0;
      const entry = this.topics.get(data.topic)!;
      const subscribers = entry.subscribers;
      const i = subscribers.size;
      if (subscribers.has(key)) {
        subscribers.delete(key);
      }
      this.logger.debug('[unsubscribe] %s/%s', key, data.topic);
      this.cleanupTopicIfUnused(data.topic, entry);
      return i - subscribers.size;
    }))
  }

  private registerReceiveTopicUpdate() {
    this.fallbacks.add(this.register<{ topic: string, payload: any }, { client?: Client }>('/-/topic/update', async ({ data, client }) => {
      // 转发
      const key = client ? `${client.host}:${client.port}` : undefined;
      const entry = this.topics.get(data.topic);
      if (key && entry?.publishers.has(key)) {
        return this.publish(data.topic, data.payload, key) ?? Date.now();
      }
      return this.publish(data.topic, data.payload) ?? Date.now();
    }))
  }

  private notifySubscribers(topic: string, payload: any, entry: TopicEntry) {
    for (const key of entry.subscribers.values()) {
      try {
        if (this.clients.has(key)) {
          this.clients.get(key)!.pushControl(`/-/topic/update`, { topic, payload });
        }
      } catch {
        // 推送失败，disconnect 事件中会清理
      }
    }
  }

  private publish(topic: string, payload: any, publisherKey?: string, revision?: number) {
    if (!this.topics.has(topic)) return;
    const entry = this.topics.get(topic)!;
    if (publisherKey) {
      const nextRevision = this.rememberPublisherPayload(entry, publisherKey, payload, revision);
      this.restoreTopicDataFromRemainingPublishers(topic, entry);
      return nextRevision;
    }
    const changed = this.setTopicData(entry, payload);
    if (!changed) return;
    this.notifySubscribers(topic, payload, entry);
    return ++this.topicRevision;
  }
}
