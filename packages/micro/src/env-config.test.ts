import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

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

  it('reloads config when yaml file changes', async () => {
    const configFile = join(configsDir, 'svc-b.config.yaml');
    writeFileSync(configFile, 'value: 1');
    const registry = new Registry(testAdvertise);

    const watcher = registry.watchEnvFile();
    expect((registry as any).configs.get('svc-b')).toEqual({ value: 1 });

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
    expect(watcher).toBeUndefined();
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
