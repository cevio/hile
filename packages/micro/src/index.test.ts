import { createServer, type Socket } from 'node:net';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { selectRandomRegistryAddress } from './registry';
import { Application } from './application';
import { Registry } from './registry';
import { Server } from './server';

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
    super('test');
  }

  public open(host: string, port: number, timeout: number) {
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
});

describe('@hile/micro application discovery', () => {
  it('resolves a provider through the registry on first lookup', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry();
    const provider = new Application({
      namespace: 'provider',
      registry: { host: '127.0.0.1', port: registryPort },
    });
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
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
});

describe('@hile/micro server connection', () => {
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
});
