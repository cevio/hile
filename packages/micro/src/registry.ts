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

export class Registry extends Server {
  private readonly namespaces = new Map<string, Set<string>>();
  private readonly workspace: string;
  private readonly configFileSuffix = '.config.yaml';
  private readonly configs = new Map<string, any>();
  private readonly fallbacks = new Set<() => void>();
  private readonly topics = new Map<string, {
    publishers: Set<string>;
    subscribers: Set<string>;
    data: any;
  }>();

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
    });
    this.events.on('disconnect', (client: Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      // 清理 topic 中的关联
      for (const [topic, { publishers, subscribers }] of this.topics) {
        if (publishers.has(key)) publishers.delete(key);
        if (subscribers.has(key)) subscribers.delete(key);
        if (publishers.size === 0 && subscribers.size === 0) {
          this.topics.delete(topic);
        }
      }
      // 清理 namespace 中的关联
      const namespace = extras.join('/');
      if (this.namespaces.has(namespace)) {
        const keys = this.namespaces.get(namespace)!;
        if (keys.has(key)) {
          keys.delete(key);
          if (keys.size === 0) {
            this.namespaces.delete(namespace);
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
  }

  public watchEnvFile() {
    const configFile = resolve(this.workspace, 'configs');
    if (!existsSync(configFile)) return;
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
            this.topics.set(_key, { publishers: new Set(), subscribers: new Set(), data: config[key] });
          }
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
            this.topics.set(_key, { publishers: new Set(), subscribers: new Set(), data: config[key] });
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
      for (const fallback of this.fallbacks) {
        fallback();
      }
      this.fallbacks.clear();
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
    this.fallbacks.add(this.register<{ topic: string, payload: any }, { client: Client }>('/-/declare', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) {
        this.topics.set(data.topic, { publishers: new Set(), subscribers: new Set(), data: data.payload });
      }
      const entry = this.topics.get(data.topic)!;
      const publishers = entry.publishers;
      entry.data = data.payload;
      publishers.add(key);
      this.publish(data.topic, data.payload);
      return Date.now();
    }))
  }

  private registerUndeclare() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/undeclare', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) return 0;
      const entry = this.topics.get(data.topic)!;
      const publishers = entry.publishers;
      const subscribers = entry.subscribers;
      const i = publishers.size;
      if (publishers.has(key)) {
        publishers.delete(key);
        if (publishers.size === 0 && subscribers.size === 0) {
          this.topics.delete(data.topic);
        }
      }
      return i - publishers.size;
    }))
  }

  private registerSubscribe() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/subscribe', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) {
        this.topics.set(data.topic, { publishers: new Set(), subscribers: new Set(), data: undefined });
      }
      const entry = this.topics.get(data.topic)!;
      const subscribers = entry.subscribers;
      subscribers.add(key);
      return entry.data;
    }))
  }

  private registerUnsubscribe() {
    this.fallbacks.add(this.register<{ topic: string }, { client: Client }>('/-/unsubscribe', async ({ data, client }) => {
      const key = `${client.host}:${client.port}`;
      if (!this.topics.has(data.topic)) return 0;
      const entry = this.topics.get(data.topic)!;
      const subscribers = entry.subscribers;
      const publishers = entry.publishers;
      const i = subscribers.size;
      if (subscribers.has(key)) {
        subscribers.delete(key);
        if (subscribers.size === 0 && publishers.size === 0) {
          this.topics.delete(data.topic);
        }
      }
      return i - subscribers.size;
    }))
  }

  private registerReceiveTopicUpdate() {
    this.fallbacks.add(this.register<{ topic: string, payload: any }>('/-/topic/update', async ({ data }) => {
      // 转发
      this.publish(data.topic, data.payload);
      return Date.now();
    }))
  }

  private publish(topic: string, payload: any) {
    if (!this.topics.has(topic)) return;
    const entry = this.topics.get(topic)!;
    const subscribers = entry.subscribers;
    entry.data = payload;
    for (const key of subscribers.values()) {
      try {
        if (this.clients.has(key)) {
          this.clients.get(key)!.push(`/-/topic/update`, { topic, payload });
        }
      } catch {
        // 推送失败，disconnect 事件中会清理                                                             
      }
    }
  }
}
