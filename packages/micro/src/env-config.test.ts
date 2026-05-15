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

describe('@hile/micro env file from workspace', () => {
  const registryDir = join(testDir, '.registry');
  const envFile = join(registryDir, '.env');

  beforeEach(() => {
    mkdirSync(registryDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(registryDir, { recursive: true, force: true });
  });

  it('loads env file on construction', () => {
    writeFileSync(envFile, 'TEST_REG_FOO=hello');
    const registry = new Registry(testAdvertise);
    expect(process.env.TEST_REG_FOO).toBe('hello');
    delete process.env.TEST_REG_FOO;
  });

  it('reloads env vars when .env file changes', async () => {
    writeFileSync(envFile, 'TEST_REG_FOO=1\nTEST_REG_BAR=2');
    const registry = new Registry(testAdvertise);
    expect(process.env.TEST_REG_FOO).toBe('1');
    expect(process.env.TEST_REG_BAR).toBe('2');

    const watcher = registry.watchEnvFile();
    expect(watcher).toBeDefined();
    expect(typeof watcher!.close).toBe('function');

    writeFileSync(envFile, 'TEST_REG_FOO=3\nTEST_REG_BAR=4');

    await vi.waitFor(() => {
      expect(process.env.TEST_REG_FOO).toBe('3');
      expect(process.env.TEST_REG_BAR).toBe('4');
    }, { timeout: 3000, interval: 100 });

    watcher!.close();
    delete process.env.TEST_REG_FOO;
    delete process.env.TEST_REG_BAR;
  });

  it('does not crash when env file does not exist', () => {
    rmSync(envFile, { force: true });
    const registry = new Registry(testAdvertise);
    const watcher = registry.watchEnvFile();
    expect(watcher).toBeUndefined();
  });
});

describe('@hile/micro /-/env endpoint', () => {
  it('returns requested env vars', async () => {
    process.env.TEST_ENV_X = 'x-value';
    process.env.TEST_ENV_Y = 'y-value';

    const registry = new Registry(testAdvertise);
    const result = await registry.dispatch('/-/env', ['TEST_ENV_X', 'TEST_ENV_Y']);
    expect(result).toEqual(['x-value', 'y-value']);

    delete process.env.TEST_ENV_X;
    delete process.env.TEST_ENV_Y;
  });

  it('returns undefined for non-existent env vars', async () => {
    const registry = new Registry(testAdvertise);
    const result = await registry.dispatch('/-/env', ['NONEXISTENT_VAR_ABCD']);
    expect(result).toEqual([undefined]);
  });

  it('handles empty names list', async () => {
    const registry = new Registry(testAdvertise);
    const result = await registry.dispatch('/-/env', []);
    expect(result).toEqual([]);
  });
});

describe('@hile/micro Application.getEnvVariables', () => {
  it('fetches env vars from Registry', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    process.env.TEST_APP_VAR = 'app-value';

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'env-app',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      const result = await app.getEnvVariables('TEST_APP_VAR');
      expect(result).toEqual(['app-value']);
    } finally {
      await disposeApp();
      await disposeRegistry();
      delete process.env.TEST_APP_VAR;
    }
  });
});
