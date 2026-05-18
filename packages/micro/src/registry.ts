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
  private unregisterFind?: () => void;
  private readonly workspace: string;
  private readonly configFileSuffix = '.config.yaml';
  private readonly configs = new Map<string, any>();

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
  }

  public watchEnvFile() {
    const configFile = resolve(this.workspace, 'configs');
    if (!existsSync(configFile)) return;
    const configFiles = readdirSync(configFile).filter(filename => filename.endsWith(this.configFileSuffix));
    for (const filename of configFiles) {
      try {
        const config = YAML.parse(readFileSync(resolve(configFile, filename), 'utf8'));
        if (typeof config !== 'object' || config === null) continue;
        this.configs.set(parseConfigFilename(filename)!, config);
      } catch { }
    }
    return watch(configFile, (_, filename) => {
      if (!filename?.endsWith(this.configFileSuffix)) return;
      const fullPath = resolve(configFile, filename);
      // 文件被删除（或重命名）：移除对应配置
      if (!existsSync(fullPath)) {
        this.configs.delete(parseConfigFilename(filename)!);
        return;
      }
      try {
        const config = YAML.parse(readFileSync(fullPath, 'utf8'));
        if (typeof config !== 'object' || config === null) return;
        this.configs.set(parseConfigFilename(filename)!, config);
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
    this.register<{ namespace: string, fields?: string[] }[]>('/-/env/variables', async ({ data }) => {
      return data.map(({ namespace, fields }) => {
        if (!this.configs.has(namespace)) {
          return { namespace, value: null };
        }
        if (!fields?.length) return { namespace, value: this.configs.get(namespace) };
        const config = this.configs.get(namespace);
        const value: Record<string, any> = {};
        for (const field of fields) {
          value[field] = config[field];
        }
        return { namespace, value };
      });
    })
  }
}
