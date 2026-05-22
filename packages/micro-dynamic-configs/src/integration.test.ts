/**
 * Integration tests for @hile/micro-dynamic-configs.
 *
 * Requires:
 *   - Redis on 127.0.0.1:6379
 *   - Available TCP ports (allocated dynamically)
 *
 * Run with: INTEGRATION=true pnpm test
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Registry, Application, Client } from '@hile/micro';
import { MicroDynamicConfigsServer } from './server.js';
import Redis from 'ioredis';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

// ---------------------------------------------------------------------------
// Guard — only enabled with INTEGRATION=true env var
// ---------------------------------------------------------------------------

const isIntegration = process.env.INTEGRATION === 'true';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Compare by JSON serialization so arrays/objects are compared by value */
function isMatch(value: Record<string, any>, expected: Record<string, any>): boolean {
  return Object.entries(expected).every(
    ([k, v]) => JSON.stringify(value[k]) === JSON.stringify(v),
  );
}

async function waitForValue(
  getValues: () => Record<string, any>,
  expected: Record<string, any>,
  timeout = 5000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = getValues();
    if (isMatch(current, expected)) return { ...current };
    await new Promise(r => setTimeout(r, 50));
  }
  const last = getValues();
  throw new Error(
    `Timed out waiting for ${JSON.stringify(expected)}, last value: ${JSON.stringify(last)}`,
  );
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const schema = z.object({
  name: z.string().default(''),
  port: z.number().default(8080),
  debug: z.boolean().default(false),
  labels: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!isIntegration)('integration | real Redis + WebSocket', () => {
  let redis: Redis;
  let redisKey: string;

  let registry: Registry;
  let configApp: Application;
  let subscriberApp: Application;

  let server: MicroDynamicConfigsServer<Application, typeof schema>;

  let teardownRegistry: () => Promise<void>;
  let teardownConfig: () => Promise<void>;
  let teardownSubscriber: () => Promise<void>;
  let serverTeardown: () => void;

  // -----------------------------------------------------------------------
  // Setup
  // -----------------------------------------------------------------------

  beforeAll(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379 });
    // Verify Redis is reachable before proceeding
    await redis.ping().catch((e: Error) => {
      throw new Error(
        `Redis unreachable (127.0.0.1:6379): ${e.message}. ` +
        'Start Redis or verify connection config before running integration tests.',
      );
    });

    redisKey = `test:config:${randomUUID().slice(0, 8)}`;

    const registryPort = await findFreePort();
    const configPort = await findFreePort();
    const subscriberPort = await findFreePort();

    // 1. Registry
    process.env.REGISTRY_PORT = String(registryPort);
    registry = new Registry({ advertiseHost: '127.0.0.1' });
    teardownRegistry = await registry.listen(registryPort);

    // 2. Config App
    configApp = new Application({
      namespace: 'config-svc',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
    });
    teardownConfig = await configApp.listen(configPort);

    // 3. Dynamic Config Server
    server = new MicroDynamicConfigsServer({
      app: configApp,
      redis,
      schema,
      redis_key: redisKey,
    });
    serverTeardown = await server.initialize();

    // 4. Subscriber App
    subscriberApp = new Application({
      namespace: 'subscriber',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
    });
    teardownSubscriber = await subscriberApp.listen(subscriberPort);

    // 5. Config Clients (subscriber side)
  }, 30_000);

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  afterAll(async () => {
    serverTeardown?.();
    await teardownSubscriber?.();
    await teardownConfig?.();
    await teardownRegistry?.();
    if (redisKey) await redis?.del(redisKey);
    await redis?.quit();
  }, 30_000);

  // -----------------------------------------------------------------------
  // Test: Redis persistence
  // -----------------------------------------------------------------------

  it('persists config to Redis and loads on restart', async () => {
    await server.save({ name: 'persist-me', port: 9090 });

    // Read back from Redis directly
    const raw = await redis.get(redisKey);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.name).toBe('persist-me');
    expect(parsed.port).toBe(9090);
    expect(parsed.debug).toBe(false);

    // Simulate restart: new server loads from Redis
    const server2 = new MicroDynamicConfigsServer({
      app: configApp,
      redis,
      schema,
      redis_key: redisKey,
    });
    await server2.initialize();
    expect(server2.value.name).toBe('persist-me');
    expect(server2.value.port).toBe(9090);
  }, 15_000);

  // -----------------------------------------------------------------------
  // Test: subscribe + push
  // -----------------------------------------------------------------------

  it('subscribes to config and receives push updates', async () => {
    // Reset to known state
    await server.save({ name: 'initial', port: 8080, debug: true, labels: ['a'] });

    const values: Record<string, any> = {};
    await subscriberApp.subscribe('config-svc:name', (v) => values.name = v);
    await subscriberApp.subscribe('config-svc:port', (v) => values.port = v);
    await subscriberApp.subscribe('config-svc:debug', (v) => values.debug = v);
    await subscriberApp.subscribe('config-svc:labels', (v) => values.labels = v);

    expect(values.name).toBe('initial');
    expect(values.port).toBe(8080);
    expect(values.debug).toBe(true);
    expect(values.labels).toEqual(['a']);

    // Publish a single-field change — server pushes to subscriber
    await server.save({ name: 'pushed' });

    // Wait for push to arrive and update subscriber cache
    const updated = await waitForValue(
      () => values,
      { name: 'pushed' },
    );
    expect(updated.name).toBe('pushed');
    // Unchanged fields keep their previous values
    expect(updated.port).toBe(8080);
    expect(updated.debug).toBe(true);
    expect(updated.labels).toEqual(['a']);
  }, 15_000);

  // -----------------------------------------------------------------------
  // Test: array-typed field via push
  // -----------------------------------------------------------------------

  it('receives push for array-typed field', async () => {
    await server.save({ labels: ['x', 'y', 'z'] });

    const values: Record<string, any> = {};
    await subscriberApp.subscribe('config-svc:labels', (v) => values.labels = v);

    const updated = await waitForValue(
      () => values,
      { labels: ['x', 'y', 'z'] },
    );
    expect(updated.labels).toEqual(['x', 'y', 'z']);
  }, 15_000);

  // -----------------------------------------------------------------------
  // Test: rapid sequential saves
  // -----------------------------------------------------------------------

  it('handles rapid sequential saves', async () => {
    const values: Record<string, any> = {};
    await subscriberApp.subscribe('config-svc:port', (v) => values.port = v);

    for (let i = 0; i < 5; i++) {
      await server.save({ port: 9000 + i });
    }

    const updated = await waitForValue(
      () => values,
      { port: 9004 },
    );
    expect(updated.port).toBe(9004);
  }, 15_000);

  // -----------------------------------------------------------------------
  // Test: disconnect → reconnect
  // -----------------------------------------------------------------------

  it('reconnects after WebSocket disconnect and gets latest value', async () => {
    // Collect current registry port before teardown
    const registryPort = Number(process.env.REGISTRY_PORT);

    // Force disconnect by closing the subscriber app
    await teardownSubscriber();
    // Wait for disconnect events to propagate to the config server
    // (WebSocket close → config server's createClient close handler → cleanup)
    await new Promise(r => setTimeout(r, 300));

    // Save a new value while subscriber is disconnected
    await server.save({ name: 'after-disconnect' });

    // Recreate subscriber app and configs
    const newPort = await findFreePort();
    subscriberApp = new Application({
      namespace: 'subscriber',
      registry: { host: '127.0.0.1', port: registryPort },
      advertiseHost: '127.0.0.1',
    });
    teardownSubscriber = await subscriberApp.listen(newPort);
    const values2: Record<string, any> = {};
    await subscriberApp.subscribe('config-svc:name', (v) => values2.name = v);
    await subscriberApp.subscribe('config-svc:port', (v) => values2.port = v);

    expect(values2.name).toBe('after-disconnect');
  }, 15_000);
});
