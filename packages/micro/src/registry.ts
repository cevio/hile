import { Server, type MicroServerProps } from './server';
import { Client } from './client';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, watch } from 'node:fs';
import dotenv from 'dotenv';

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

export class Registry extends Server {
  private readonly namespaces = new Map<string, Set<string>>();
  private unregisterFind?: () => void;
  private static readonly HEARTBEAT_INTERVAL = 1000;
  private static readonly HEARTBEAT_TIMEOUT = 20000;
  private readonly heartbeats = new Map<string, number>();
  private readonly _envfile: string;

  constructor(props: MicroServerProps = {}) {
    const workspace = resolve(homedir(), '.registry');
    if (!existsSync(workspace)) {
      mkdirSync(workspace, { recursive: true });
    }
    const envFile = resolve(workspace, '.env');
    if (existsSync(envFile)) {
      process.loadEnvFile(envFile);
    }
    if (!props.advertiseHost && process.env.REGISTRY_HOST) {
      props.advertiseHost = process.env.REGISTRY_HOST;
    }
    super('registry', props);
    this._envfile = envFile;
    this.events.on('connect', (client: Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      this.heartbeats.set(key, Date.now());
      const namespace = extras.join('/');
      if (!this.namespaces.has(namespace)) {
        this.namespaces.set(namespace, new Set());
      }
      this.namespaces.get(namespace)!.add(key);
    });
    this.events.on('disconnect', (client: Client, extras: string[]) => {
      const key = client.host + ':' + client.port;
      this.heartbeats.delete(key);
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
    this.mountFindHandler();
    this.registerEnvVariables();
    this.register<{}, { client: Client }>('/-/heartbeat', async ({ client }) => {
      if (!client) return;
      const key = client.host + ':' + client.port;
      this.heartbeats.set(key, Date.now());
    });
  }

  public watchEnvFile() {
    if (!existsSync(this._envfile)) return;
    const workspace = resolve(this._envfile, '..');
    return watch(workspace, (_, filename) => {
      if (filename !== '.env') return;
      try {
        dotenv.config({ path: this._envfile, override: true });
        process.env.REGISTRY_PORT = this.port?.toString() || '';
        process.env.REGISTRY_HOST = this.host;
      } catch { /* vim 替换文件时的中间态读错误，忽略 */ }
    });
  }

  public async listen(port: number = 0) {
    const registry_port = process.env.REGISTRY_PORT ? Number(process.env.REGISTRY_PORT) : 0;
    const _port = port || registry_port;
    if (!_port || _port <= 0) throw new Error('Unable to resolve registry port: pass `port` in constructor options, or ensure process.env.REGISTRY_PORT is set.');
    const teardown = await super.listen(_port);
    const timer = setInterval(() => {
      const now = Date.now();
      for (const [key, lastTime] of this.heartbeats) {
        if (now - lastTime >= Registry.HEARTBEAT_TIMEOUT) {
          const client = this.clients.get(key);
          if (client) {
            this.heartbeats.delete(key);
            client.dispose();
          }
        }
      }
    }, Registry.HEARTBEAT_INTERVAL);

    process.env.REGISTRY_PORT = this.port?.toString() || '';
    process.env.REGISTRY_HOST = this.host;

    const watcher = this.watchEnvFile();

    return async () => {
      if (watcher) watcher.close();
      clearInterval(timer);
      await teardown();
    };
  }

  /** 幂等：重复调用会先注销上一条 `/-/find` 再注册，避免叠多条路由 */
  public onFind() {
    this.mountFindHandler();
  }

  private mountFindHandler() {
    if (this.unregisterFind) {
      this.unregisterFind();
      this.unregisterFind = undefined;
    }
    this.unregisterFind = this.register<RegistryFindData, { client: Client }>('/-/find', async ({ data }) => {
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
    });
  }

  private registerEnvVariables() {
    this.register<string[]>('/-/env', async ({ data }) => {
      const names = data || [];
      return names.map(name => process.env[name]);
    })
  }
}
