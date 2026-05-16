import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';

const testDir = `/tmp/registry-env-test-${process.pid}-${Date.now()}`;

vi.mock('node:os', () => ({
  homedir: () => testDir,
}));

import { Registry } from './registry';
import { Application } from './application';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
  return address.port;
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

describe('@hile/micro /-/env/variables endpoint', () => {
  const configsDir = join(testDir, '.registry', 'configs');
  let configFile: string;

  beforeEach(() => {
    mkdirSync(configsDir, { recursive: true });
    configFile = join(configsDir, 'test-svc.config.yaml');
    writeFileSync(configFile, 'host: localhost\nport: 8080\ndebug: true');
  });

  afterAll(() => {
    rmSync(join(testDir, '.registry'), { recursive: true, force: true });
  });

  it('returns requested config by namespace and fields', async () => {
    const registry = new Registry(testAdvertise);
    registry.watchEnvFile();

    const result = await registry.dispatch('/-/env/variables', [
      { namespace: 'test-svc', fields: ['host', 'port'] },
    ]);
    expect(result).toEqual([
      { namespace: 'test-svc', value: { host: 'localhost', port: 8080 } },
    ]);
  });

  it('returns all config when fields not specified', async () => {
    const registry = new Registry(testAdvertise);
    registry.watchEnvFile();

    const result = await registry.dispatch('/-/env/variables', [
      { namespace: 'test-svc' },
    ]);
    expect(result).toEqual([
      { namespace: 'test-svc', value: { host: 'localhost', port: 8080, debug: true } },
    ]);
  });

  it('returns null value for non-existent namespace', async () => {
    const registry = new Registry(testAdvertise);
    registry.watchEnvFile();

    const result = await registry.dispatch('/-/env/variables', [
      { namespace: 'no-such-svc' },
    ]);
    expect(result).toEqual([
      { namespace: 'no-such-svc', value: null },
    ]);
  });

  it('handles empty data list', async () => {
    const registry = new Registry(testAdvertise);
    registry.watchEnvFile();

    const result = await registry.dispatch('/-/env/variables', []);
    expect(result).toEqual([]);
  });
});

describe('@hile/micro Application.getEnvVariables', () => {
  const configsDir = join(testDir, '.registry', 'configs');

  beforeEach(() => {
    mkdirSync(configsDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(join(testDir, '.registry'), { recursive: true, force: true });
  });

  it('fetches config from Registry', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    // Write config
    writeFileSync(join(configsDir, 'test-app.config.yaml'), 'db_host: localhost\ndb_port: 3306');

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'env-app',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      const result = await app.getEnvVariables(
        { namespace: 'test-app', fields: ['db_host'] },
      );
      expect(result).toEqual({ 'test-app': { db_host: 'localhost' } });
    } finally {
      await disposeApp();
      await disposeRegistry();
    }
  });

  it('returns null when namespace config does not exist', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'env-app',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      const result = await app.getEnvVariables(
        { namespace: 'no-such-svc' },
      );
      expect(result).toEqual({ 'no-such-svc': null });
    } finally {
      await disposeApp();
      await disposeRegistry();
    }
  });
});
