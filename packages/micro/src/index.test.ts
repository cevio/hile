import { createServer, type Socket } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket from 'ws';
import { selectRandomRegistryAddress, parseAddressKey } from './registry';
import { Application } from './application';
import { Registry } from './registry';
import { Server } from './server';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate test port');
  }
  return address.port;
}

async function startHangingServer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to allocate hanging test port');
  }

  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

class TestServer extends Server {
  constructor() {
    super('test', testAdvertise);
  }

  public open(host: string, port: number, timeout: number) {
    this.setPort(1);
    return this.connect(host, port, timeout);
  }
}

/** 用于断言「未 setPort 不能 connect」，与 `open` 用例分离 */
class ServerWithoutAnnounce extends Server {
  constructor() {
    super('no-announce', testAdvertise);
  }

  public attemptConnect(host: string, port: number, timeout: number) {
    return this.connect(host, port, timeout);
  }
}

describe('@hile/micro registry selection', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when no service is registered', () => {
    expect(selectRandomRegistryAddress([])).toBeUndefined();
  });

  it('returns the only registered service', () => {
    expect(selectRandomRegistryAddress(['127.0.0.1:3000'])).toEqual({
      host: '127.0.0.1',
      port: 3000,
    });
  });

  it('uses Math.random to select from registered services', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.75);

    expect(
      selectRandomRegistryAddress([
        '127.0.0.1:3000',
        '127.0.0.1:3001',
        '127.0.0.1:3002',
        '127.0.0.1:3003',
      ]),
    ).toEqual({
      host: '127.0.0.1',
      port: 3003,
    });
  });

  it('never returns an address outside the registered services', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.49);

    const services = ['10.0.0.1:4100', '10.0.0.2:4200'];

    expect(selectRandomRegistryAddress(services)).toEqual({
      host: '10.0.0.1',
      port: 4100,
    });
  });

  it('parses bracketed IPv6 host:port keys', () => {
    expect(parseAddressKey('[::1]:9000')).toEqual({ host: '[::1]', port: 9000 });
  });

  it('skips malformed keys when selecting', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(selectRandomRegistryAddress(['bogus', '127.0.0.1:1'])).toEqual({
      host: '127.0.0.1',
      port: 1,
    });
  });

  it('find handler survives repeated onFind()', async () => {
    const r = new Registry(testAdvertise);
    r.onFind();
    r.onFind();
    const p = await getAvailablePort();
    const d = await r.listen(p);
    try {
      await expect(r.dispatch('/-/find', { namespace: 'none' })).resolves.toBeUndefined();
    } finally {
      await d();
    }
  });
});

describe('@hile/micro application discovery', () => {
  it('resolves a provider through the registry on first lookup', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'provider',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregisterEcho = provider.register<{ value: string }>('/echo', async ({ data }) => {
      return { value: data.value };
    });

    try {
      const client = await consumer.get('provider');
      const { response } = client.request('/echo', { value: 'ok' });

      await expect(response<{ value: string }>()).resolves.toEqual({ value: 'ok' });
    } finally {
      unregisterEcho();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('allows listen again on the same Application after teardown', async () => {
    const registryPort = await getAvailablePort();
    const appPort1 = await getAvailablePort();
    const appPort2 = await getAvailablePort();
    const providerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 're-listen',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const provider = new Application({
      namespace: 'peer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const unregister = provider.register('/x', async () => ({ ok: true }));

    const dispose1 = await app.listen(appPort1);
    await dispose1();
    const dispose2 = await app.listen(appPort2);

    try {
      const client = await app.get('peer');
      const { response } = client.request('/x', {});
      await expect(response()).resolves.toEqual({ ok: true });
    } finally {
      unregister();
      await dispose2();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('rolls back listen when registry is unreachable', async () => {
    const deadPort = await getAvailablePort();
    const port = await getAvailablePort();
    const app = new Application({
      namespace: 'rollback',
      registry: { host: '127.0.0.1', port: deadPort },
      ...testAdvertise,
    });
    await expect(app.listen(port)).rejects.toThrow();
    const s2 = new Server('probe', testAdvertise);
    const dispose = await s2.listen(port);
    await dispose();
  });
});

describe('@hile/micro server connection', () => {
  it('rejects connect when local announce port was not set', async () => {
    const server = new ServerWithoutAnnounce();
    await expect(server.attemptConnect('127.0.0.1', 9, 10)).rejects.toThrow(
      'local port',
    );
  });

  it('rejects when websocket handshake exceeds the connection timeout', async () => {
    const hangingServer = await startHangingServer();
    const server = new TestServer();
    const connection = server.open('127.0.0.1', hangingServer.port, 50);
    connection.catch(() => undefined);

    try {
      await expect(
        Promise.race([
          connection,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Expected connection timeout')), 150)),
        ]),
      ).rejects.toThrow('Connection timeout');
    } finally {
      await hangingServer.close();
    }
  });

  it('closes inbound websocket when path port is not a valid TCP port', async () => {
    const port = await getAvailablePort();
    const server = new Server('svc', testAdvertise);
    const dispose = await server.listen(port);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/127.0.0.1/not-a-port/extra`);
      const t = setTimeout(() => reject(new Error('expected socket to close')), 2000);
      ws.on('close', () => {
        clearTimeout(t);
        resolve();
      });
      ws.on('error', () => {});
    });
    await dispose();
  });

  it('closes inbound websocket when path port is out of range', async () => {
    const port = await getAvailablePort();
    const server = new Server('svc', testAdvertise);
    const dispose = await server.listen(port);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/127.0.0.1/65536/extra`);
      const t = setTimeout(() => reject(new Error('expected socket to close')), 2000);
      ws.on('close', () => {
        clearTimeout(t);
        resolve();
      });
      ws.on('error', () => {});
    });
    await dispose();
  });

  it('replaces prior inbound client when the same caller host:port connects again', async () => {
    const port = await getAvailablePort();
    const server = new Server('svc', testAdvertise);
    const dispose = await server.listen(port);
    const path = `ws://127.0.0.1:${port}/192.0.2.1/12345/svc`;
    const ws1 = new WebSocket(path);
    await new Promise<void>((resolve, reject) => {
      ws1.once('open', () => resolve());
      ws1.once('error', reject);
    });
    const ws2 = new WebSocket(path);
    await new Promise<void>((resolve, reject) => {
      ws2.once('open', () => resolve());
      ws2.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('expected first socket to close after replace')), 2000);
      if (ws1.readyState === WebSocket.CLOSED) {
        clearTimeout(t);
        resolve();
        return;
      }
      ws1.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
    expect(ws2.readyState).toBe(WebSocket.OPEN);
    ws2.close();
    await new Promise<void>((resolve) => {
      ws2.once('close', () => resolve());
    });
    await dispose();
  });
});

describe('@hile/micro heartbeat', () => {
  it('keeps client alive when heartbeats arrive on time', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'hb-keepalive',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    try {
      // Wait 2.5s (>2 heartbeat cycles) — should remain connected
      await new Promise(r => setTimeout(r, 2500));
      const entryKey = `127.0.0.1:${appPort}`;
      expect((registry as any).clients.has(entryKey)).toBe(true);
      expect((registry as any).heartbeats.has(entryKey)).toBe(true);
    } finally {
      await disposeApp();
      await disposeRegistry();
    }
  });

  it('disconnects client that stops sending heartbeats', async () => {
    const registryPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const disposeRegistry = await registry.listen(registryPort);

    // A raw Server connected to Registry sends no heartbeats
    const silent = new Server('silent', testAdvertise);
    silent.setPort(1);
    // Use type assertion to access protected connect method
    const silentClient = await (silent as any).connect('127.0.0.1', registryPort);
    // The Registry-side Client records silent's host:port (from the WS path), not registry's
    const entryKey = '127.0.0.1:1';

    try {
      // Set last heartbeat to 25s ago to simulate timeout
      (registry as any).heartbeats.set(entryKey, Date.now() - 25000);
      // Wait for polling cycle (1s interval + buffer)
      await new Promise(r => setTimeout(r, 1500));
      // Client should be evicted
      expect((registry as any).clients.has(entryKey)).toBe(false);
    } finally {
      silentClient.dispose();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro circuit breaker', () => {
  it('call() returns data on success', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'svc',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register<{ value: string }>('/echo', async ({ data }) => {
      return { value: data.value };
    });

    try {
      const result = await consumer.call('svc', '/echo', { value: 'ok' });
      expect(result).toEqual({ value: 'ok' });
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('excludes a failing peer and selects a different one', async () => {
    const registryPort = await getAvailablePort();
    const portA = await getAvailablePort();
    const portB = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const providerA = new Application({
      namespace: 'svc',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const providerB = new Application({
      namespace: 'svc',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeA = await providerA.listen(portA);
    const disposeConsumer = await consumer.listen(consumerPort);

    // Only A is registered initially — it always fails
    const unregisterA = providerA.register('/api', async () => {
      throw new Error('A fail');
    });

    let disposeB: () => Promise<void>;

    try {
      // First call → hits A (only option) → fails → A is excluded
      await expect(consumer.call('svc', '/api', {})).rejects.toThrow('A fail');

      // Now register B (which succeeds)
      disposeB = await providerB.listen(portB);
      const unregisterB = providerB.register('/api', async () => ({ ok: true }));

      // Second call → A excluded → Registry picks B → succeeds
      const result = await consumer.call('svc', '/api', {});
      expect(result).toEqual({ ok: true });

      unregisterB();
    } finally {
      unregisterA();
      await disposeConsumer();
      if (disposeB) await disposeB();
      await disposeA();
      await disposeRegistry();
    }
  });

  it('resets breaker when all peers are excluded', async () => {
    const registryPort = await getAvailablePort();
    const portA = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const providerA = new Application({
      namespace: 'svc',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeA = await providerA.listen(portA);
    const disposeConsumer = await consumer.listen(consumerPort);

    let unregisterA = providerA.register('/api', async () => {
      throw new Error('A fail');
    });

    try {
      // Single peer that fails → gets excluded → all excluded → reset
      await expect(consumer.call('svc', '/api', {})).rejects.toThrow('A fail');

      // Now make it succeed
      unregisterA();
      unregisterA = () => {};
      const unregisterA2 = providerA.register('/api', async () => ({ ok: true }));

      // All peers excluded → reset → retries A → now succeeds
      const result = await consumer.call('svc', '/api', {});
      expect(result).toEqual({ ok: true });

      unregisterA2();
    } finally {
      unregisterA();
      await disposeConsumer();
      await disposeA();
      await disposeRegistry();
    }
  });
});
