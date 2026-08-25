import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Application } from './application';

const testDir = `/tmp/registry-env-test-${process.pid}-${Date.now()}`;

vi.mock('node:os', () => ({
  homedir: () => testDir,
}));

import { Registry, getRegistryConfigsDir, namespaceToConfigFile, parseConfigFilename } from './registry';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

async function getAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
    const port = address.port;

    // 验证端口确实可用：快速 bind 一次确认没有被残留的 TIME_WAIT 占用
    const verify = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        verify.on('error', reject);
        verify.listen(port, resolve);
      });
      await new Promise<void>((resolve, reject) => verify.close((err) => err ? reject(err) : resolve()));
      return port;
    } catch {
      verify.close();
      continue;
    }
  }
  throw new Error('Unable to allocate test port after 20 attempts');
}

describe('@hile/micro config file loading', () => {
  const configsDir = join(testDir, '.registry', 'configs');

  beforeEach(() => {
    rmSync(configsDir, { recursive: true, force: true });
    mkdirSync(configsDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(join(testDir, '.registry'), { recursive: true, force: true });
  });

  it('loads yaml config files on watchEnvFile', () => {
    writeFileSync(join(configsDir, 'svc-a.config.yaml'), 'key: value\nnested:\n  foo: bar');
    const registry = new Registry(testAdvertise);
    const watcher = registry.watchEnvFile();
    expect(watcher).toBeDefined();

    // Access internal configs Map
    const configs = (registry as any).configs;
    expect(configs.has('svc-a')).toBe(true);
    expect(configs.get('svc-a')).toEqual({ key: 'value', nested: { foo: 'bar' } });

    watcher!.close();
  });

  it('exposes loaded configs through read APIs', async () => {
    writeFileSync(join(configsDir, 'svc-read.config.yaml'), [
      'enabled: true',
      'nested:',
      '  host: localhost',
      '  port: 3000',
    ].join('\n'));
    const registry = new Registry(testAdvertise);
    const watcher = registry.watchEnvFile();

    try {
      await expect(registry.dispatch('/-/configs', {})).resolves.toEqual({
        configs: [
          {
            namespace: 'svc-read',
            keys: ['enabled', 'nested'],
          },
        ],
      });
      await expect(registry.dispatch('/-/config/get', {
        namespace: 'svc-read',
      })).resolves.toEqual({
        namespace: 'svc-read',
        hasConfig: true,
        config: {
          enabled: true,
          nested: { host: 'localhost', port: 3000 },
        },
      });
      await expect(registry.dispatch('/-/config/get', {
        namespace: 'svc-read',
        key: 'enabled',
      })).resolves.toEqual({
        namespace: 'svc-read',
        key: 'enabled',
        hasValue: true,
        value: true,
      });
      await expect(registry.dispatch('/-/config/get', {
        namespace: 'svc-read',
        key: 'missing',
      })).resolves.toEqual({
        namespace: 'svc-read',
        key: 'missing',
        hasValue: false,
      });
    } finally {
      watcher!.close();
    }
  });

  it('returns config snapshots without exposing registry state by reference', async () => {
    writeFileSync(join(configsDir, 'svc-copy.config.yaml'), [
      'nested:',
      '  value: current',
    ].join('\n'));
    const registry = new Registry(testAdvertise);
    const watcher = registry.watchEnvFile();

    try {
      const snapshot = await registry.dispatch('/-/config/get', {
        namespace: 'svc-copy',
      });
      snapshot.config.nested.value = 'mutated';

      await expect(registry.dispatch('/-/config/get', {
        namespace: 'svc-copy',
      })).resolves.toEqual({
        namespace: 'svc-copy',
        hasConfig: true,
        config: {
          nested: { value: 'current' },
        },
      });
    } finally {
      watcher!.close();
    }
  });

  it('reloads config when yaml file changes', async () => {
    const configFile = join(configsDir, 'svc-b.config.yaml');
    writeFileSync(configFile, 'value: 1');
    const registry = new Registry(testAdvertise);

    const watcher = registry.watchEnvFile();
    expect((registry as any).configs.get('svc-b')).toEqual({ value: 1 });

    await new Promise(resolve => setTimeout(resolve, 50));
    writeFileSync(configFile, 'value: 2');

    await vi.waitFor(() => {
      const configs = (registry as any).configs;
      expect(configs.get('svc-b')).toEqual({ value: 2 });
    }, { timeout: 3000, interval: 100 });

    watcher!.close();
  });

  it('does not crash when configs directory does not exist', () => {
    rmSync(configsDir, { recursive: true, force: true });
    const registry = new Registry(testAdvertise);
    const watcher = registry.watchEnvFile();
    expect(watcher).toBeDefined();
    watcher?.close();
  });

  it('watches config files created after a missing configs directory is created', async () => {
    rmSync(configsDir, { recursive: true, force: true });
    const topic = 'registry:svc-created-later/value';
    const subscriber = {
      host: '127.0.0.1',
      port: 12346,
      pushControl: vi.fn(),
    };
    const registry = new Registry(testAdvertise);
    (registry as any).clients.set('127.0.0.1:12346', subscriber);

    const watcher = registry.watchEnvFile();

    try {
      await registry.dispatch('/-/subscribe', { topic }, { client: subscriber });
      expect((registry as any).topics.get(topic)?.hasData).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 50));
      writeFileSync(join(configsDir, 'svc-created-later.config.yaml'), 'value: 101');

      await vi.waitFor(() => {
        const entry = (registry as any).topics.get(topic);
        expect(entry?.retained).toBe(true);
        expect(entry?.hasData).toBe(true);
        expect(entry?.data).toBe(101);
        expect(subscriber.pushControl).toHaveBeenCalledWith('/-/topic/update', { topic, payload: 101 });
      }, { timeout: 3000, interval: 100 });
    } finally {
      watcher?.close();
    }
  });

  it('keeps config topics after unrelated clients disconnect', async () => {
    writeFileSync(join(configsDir, 'svc-c.config.yaml'), 'value: 42');
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'config-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      expect((registry as any).topics.get('registry:svc-c/value')?.data).toBe(42);
      await disposeApp();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((registry as any).topics.get('registry:svc-c/value')?.data).toBe(42);
    } finally {
      await disposeRegistry();
    }
  });

  it('retains config topic when config appears after a subscription', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'late-config-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      await app.subscribe('registry:svc-d/value', vi.fn());
      expect((registry as any).topics.get('registry:svc-d/value')?.retained).toBe(false);

      writeFileSync(join(configsDir, 'svc-d.config.yaml'), 'value: 100');
      await vi.waitFor(() => {
        expect((registry as any).topics.get('registry:svc-d/value')?.data).toBe(100);
      }, { timeout: 3000, interval: 100 });
      expect((registry as any).topics.get('registry:svc-d/value')?.retained).toBe(true);

      await disposeApp();
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((registry as any).topics.get('registry:svc-d/value')?.data).toBe(100);
    } finally {
      await disposeRegistry();
    }
  });

  it('hydrates an existing empty config topic during initial config load', async () => {
    const topic = 'registry:svc-e/value';
    const subscriber = {
      host: '127.0.0.1',
      port: 12345,
      pushControl: vi.fn(),
    };
    const registry = new Registry(testAdvertise);
    (registry as any).clients.set('127.0.0.1:12345', subscriber);

    await registry.dispatch('/-/subscribe', { topic }, { client: subscriber });
    expect((registry as any).topics.get(topic)?.hasData).toBe(false);

    writeFileSync(join(configsDir, 'svc-e.config.yaml'), 'value: 100');
    const watcher = registry.watchEnvFile();

    try {
      const entry = (registry as any).topics.get(topic);
      expect(entry?.retained).toBe(true);
      expect(entry?.hasData).toBe(true);
      expect(entry?.data).toBe(100);
      expect(subscriber.pushControl).toHaveBeenCalledWith('/-/topic/update', { topic, payload: 100 });
    } finally {
      watcher?.close();
    }
  });
});


describe('config file utilities', () => {
  it('getRegistryConfigsDir returns path ending with .registry/configs', () => {
    const dir = getRegistryConfigsDir();
    expect(dir).toMatch(/\.registry\/configs$/);
  });

  it('namespaceToConfigFile returns path with .config.yaml suffix', () => {
    const file = namespaceToConfigFile('my-svc');
    expect(file).toMatch(new RegExp(`my-svc\\.config\\.yaml$`));
  });

  it('parseConfigFilename extracts namespace from valid filename', () => {
    expect(parseConfigFilename('my-svc.config.yaml')).toBe('my-svc');
  });

  it('parseConfigFilename returns null for non-config file', () => {
    expect(parseConfigFilename('my-svc.yaml')).toBeNull();
  });
});
