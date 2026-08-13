import { createServer, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect, vi, afterEach } from 'vitest';
import WebSocket from 'ws';
import { selectRandomRegistryAddress, parseAddressKey, parseConfigFilename } from './registry';
import { Application, type CircuitBreakerOptions } from './application';
import { Registry } from './registry';
import { Server } from './server';

const testAdvertise = { advertiseHost: '127.0.0.1' as const };

async function getAvailablePort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (!address || typeof address === 'string') {
      throw new Error('Unable to allocate test port');
    }
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
      // 端口不可用，换一个重试
      verify.close();
      continue;
    }
  }
  throw new Error('Unable to allocate test port after 20 attempts');
}

async function waitForCondition(
  predicate: () => boolean,
  message: string,
  timeout = 1000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

function createRegistryTestClient(host: string, port: number) {
  return {
    host,
    port,
    events: new EventEmitter(),
  };
}

class DelayingDeclareRegistry extends Registry {
  public readonly declareStarted = createDeferred<void>();
  public readonly releaseDeclare = createDeferred<void>();

  constructor(private readonly delayedTopic: string) {
    super(testAdvertise);
  }

  public override async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    if (path === '/-/declare' && data?.topic === this.delayedTopic) {
      this.declareStarted.resolve();
      await this.releaseDeclare.promise;
    }
    return super.dispatch(path, data, extras);
  }
}

class DelayingNthDeclareRegistry extends Registry {
  public readonly declareStarted = createDeferred<void>();
  public readonly releaseDeclare = createDeferred<void>();
  public readonly declarations: Array<{ payload: any; revision?: number }> = [];
  private declareCount = 0;

  constructor(private readonly delayedTopic: string, private readonly delayOn: number) {
    super(testAdvertise);
  }

  public override async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    if (path === '/-/declare' && data?.topic === this.delayedTopic) {
      this.declareCount++;
      this.declarations.push({ payload: data.payload, revision: data.revision });
      if (this.declareCount === this.delayOn) {
        this.declareStarted.resolve();
        await this.releaseDeclare.promise;
      }
    }
    return super.dispatch(path, data, extras);
  }
}

class DelayingSubscribeRegistry extends Registry {
  public readonly subscribeStarted = createDeferred<void>();
  public readonly releaseSubscribe = createDeferred<void>();

  constructor(private readonly delayedTopic: string) {
    super(testAdvertise);
  }

  public override async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    if (path === '/-/subscribe' && data?.topic === this.delayedTopic) {
      this.subscribeStarted.resolve();
      await this.releaseSubscribe.promise;
    }
    return super.dispatch(path, data, extras);
  }
}

class UpdatingDuringSubscribeRegistry extends Registry {
  constructor(
    private readonly topic: string,
    private readonly payload: unknown,
  ) {
    super(testAdvertise);
  }

  public override async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    if (path === '/-/subscribe' && data?.topic === this.topic) {
      const snapshot = await super.dispatch(path, data, extras);
      await super.dispatch('/-/topic/update', { topic: this.topic, payload: this.payload });
      await new Promise(resolve => setTimeout(resolve, 100));
      return snapshot;
    }
    return super.dispatch(path, data, extras);
  }
}

class DelayingUnsubscribeRegistry extends Registry {
  public readonly unsubscribeStarted = createDeferred<void>();
  public readonly releaseUnsubscribe = createDeferred<void>();

  constructor(private readonly delayedTopic: string) {
    super(testAdvertise);
  }

  public override async dispatch(path: string, data: any, extras: Record<string, any> = {}) {
    if (path === '/-/unsubscribe' && data?.topic === this.delayedTopic) {
      this.unsubscribeStarted.resolve();
      await this.releaseUnsubscribe.promise;
    }
    return super.dispatch(path, data, extras);
  }
}

class ControlledReconnectApplication extends Application {
  public readonly connectStarted = createDeferred<void>();
  public readonly releaseConnect = createDeferred<void>();
  public readonly announcedPorts: number[] = [];
  private connectCount = 0;

  protected override async connect(host: string, port: number) {
    this.connectCount++;
    this.announcedPorts.push(this.port!);
    if (this.connectCount === 2) {
      this.connectStarted.resolve();
      await this.releaseConnect.promise;
    }
    return {
      host,
      port,
      events: new EventEmitter(),
      request: vi.fn(async (url: string) => {
        if (url === '/-/subscribe') return { hasData: false, payload: undefined };
        return Date.now();
      }),
      dispose: vi.fn(),
    } as any;
  }
}

type FakePeer = {
  host: string;
  port: number;
  events: EventEmitter;
  request: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
};

function createFakePeer(
  port: number,
  request: FakePeer['request'],
  stream: FakePeer['stream'] = vi.fn(),
): FakePeer {
  return {
    host: '127.0.0.1',
    port,
    events: new EventEmitter(),
    request,
    stream,
  };
}

class CircuitBreakerTestApplication extends Application {
  public readonly lookupExcludes: Array<string[] | undefined> = [];
  public readonly selectedPeers: string[] = [];

  constructor(protected readonly peers: FakePeer[], circuitBreaker?: CircuitBreakerOptions) {
    super({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: 1 },
      logger: { debug: vi.fn(), error: vi.fn() } as any,
      ...testAdvertise,
      circuitBreaker,
    } as any);
  }

  protected override async resolveClient(namespace: string, exclude?: string[], _options?: any) {
    this.lookupExcludes.push(exclude ? [...exclude] : exclude);
    const peer = this.peers.find(peer => !exclude?.includes(`${peer.host}:${peer.port}`));
    if (!peer) throw new Error(`Namespace not found: ${namespace}`);
    this.selectedPeers.push(`${peer.host}:${peer.port}`);
    return peer as any;
  }
}

class StaleLookupCircuitBreakerTestApplication extends CircuitBreakerTestApplication {
  private staleLookups = 0;

  public returnFirstPeerOnNextLookup() {
    this.staleLookups++;
  }

  protected override async resolveClient(namespace: string, exclude?: string[], options?: any) {
    if (this.staleLookups > 0) {
      this.staleLookups--;
      this.lookupExcludes.push(exclude ? [...exclude] : exclude);
      const peer = this.peers[0];
      this.selectedPeers.push(`${peer.host}:${peer.port}`);
      return peer as any;
    }
    return super.resolveClient(namespace, exclude, options);
  }
}

class DelayedGetCircuitBreakerTestApplication extends CircuitBreakerTestApplication {
  public pausedLookups = 0;
  private delayedLookups = 0;
  private lookupGate = createDeferred<void>();

  public delayNextLookups(count: number) {
    this.pausedLookups = 0;
    this.delayedLookups = count;
    this.lookupGate = createDeferred<void>();
  }

  public releasePausedLookups() {
    this.lookupGate.resolve();
  }

  protected override async resolveClient(namespace: string, exclude?: string[], options?: any) {
    if (this.delayedLookups > 0) {
      this.delayedLookups--;
      this.pausedLookups++;
      await this.lookupGate.promise;
    }
    return super.resolveClient(namespace, exclude, options);
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

  it('parseAddressKey returns undefined for key without colon', () => {
    expect(parseAddressKey('bogus')).toBeUndefined();
  });

  it('parseAddressKey returns undefined for empty host before colon', () => {
    expect(parseAddressKey(':3000')).toBeUndefined();
  });

  it('parseAddressKey returns undefined for port 0', () => {
    expect(parseAddressKey('127.0.0.1:0')).toBeUndefined();
  });

  it('parseAddressKey returns undefined for oversized port', () => {
    expect(parseAddressKey('127.0.0.1:65536')).toBeUndefined();
  });

  it('parseAddressKey returns undefined for non-numeric port', () => {
    expect(parseAddressKey('127.0.0.1:abc')).toBeUndefined();
  });

  it('all malformed keys returns undefined', () => {
    expect(selectRandomRegistryAddress(['bogus', ''])).toBeUndefined();
  });

  it('skips malformed keys when selecting', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(selectRandomRegistryAddress(['bogus', '127.0.0.1:1'])).toEqual({
      host: '127.0.0.1',
      port: 1,
    });
  });

  it('find handler registered in constructor', async () => {
    const r = new Registry(testAdvertise);
    const p = await getAvailablePort();
    const d = await r.listen(p);
    try {
      await expect(r.dispatch('/-/find', { namespace: 'none' })).resolves.toBeUndefined();
    } finally {
      await d();
    }
  });
});

describe('@hile/micro registry read APIs', () => {
  it('lists namespaces with all connected peers', async () => {
    const registry = new Registry(testAdvertise);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3102) as any, ['svc']);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3101) as any, ['svc']);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3201) as any, ['other']);

    await expect(registry.dispatch('/-/namespaces', {})).resolves.toEqual({
      namespaces: [
        {
          namespace: 'other',
          peerCount: 1,
          peers: [{ host: '127.0.0.1', port: 3201 }],
        },
        {
          namespace: 'svc',
          peerCount: 2,
          peers: [
            { host: '127.0.0.1', port: 3101 },
            { host: '127.0.0.1', port: 3102 },
          ],
        },
      ],
    });
  });

  it('lists peers for one namespace and honors exclusions', async () => {
    const registry = new Registry(testAdvertise);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3301) as any, ['svc']);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3302) as any, ['svc']);

    await expect(registry.dispatch('/-/namespace/peers', {
      namespace: 'svc',
      exclude: ['127.0.0.1:3301'],
    })).resolves.toEqual({
      namespace: 'svc',
      peers: [{ host: '127.0.0.1', port: 3302 }],
    });

    await expect(registry.dispatch('/-/find', {
      namespace: 'svc',
      exclude: ['127.0.0.1:3301'],
    })).resolves.toEqual({ host: '127.0.0.1', port: 3302 });
  });

  it('reports registry status counts without changing registered state', async () => {
    const startedBefore = Date.now();
    const registry = new Registry(testAdvertise);
    registry.events.emit('connect', createRegistryTestClient('127.0.0.1', 3401) as any, ['svc']);
    await registry.dispatch('/-/declare', { topic: 'status-topic', payload: { ok: true } }, {
      client: { host: '127.0.0.1', port: 3401 },
    });

    const status = await registry.dispatch('/-/registry/status', {});
    expect(status).toMatchObject({
      status: 'ok',
      namespaceCount: 1,
      topicCount: 1,
      configNamespaceCount: 0,
    });
    expect(status.startedAt).toBeGreaterThanOrEqual(startedBefore);
    expect(status.uptime).toBeGreaterThanOrEqual(0);
    expect(status.clientCount).toBe(0);
  });

  it('lists topics by prefix with role counts and retained state', async () => {
    const registry = new Registry(testAdvertise);
    const publisher = { host: '127.0.0.1', port: 3501 };
    const subscriber = { host: '127.0.0.1', port: 3502 };

    await registry.dispatch('/-/declare', { topic: 'orders.created', payload: { id: 1 } }, {
      client: publisher,
    });
    await registry.dispatch('/-/subscribe', { topic: 'orders.created' }, {
      client: subscriber,
    });
    await registry.dispatch('/-/subscribe', { topic: 'billing.created' }, {
      client: subscriber,
    });

    await expect(registry.dispatch('/-/topics', { prefix: 'orders.' })).resolves.toEqual({
      topics: [
        {
          topic: 'orders.created',
          publisherCount: 1,
          subscriberCount: 1,
          hasData: true,
          retained: false,
        },
      ],
    });
  });

  it('returns a topic snapshot without subscribing the caller', async () => {
    const registry = new Registry(testAdvertise);
    const publisher = { host: '127.0.0.1', port: 3601 };

    await registry.dispatch('/-/declare', { topic: 'snapshot-topic', payload: { value: 'current' } }, {
      client: publisher,
    });

    await expect(registry.dispatch('/-/topic/get', { topic: 'snapshot-topic' })).resolves.toEqual({
      topic: 'snapshot-topic',
      publisherCount: 1,
      subscriberCount: 0,
      hasData: true,
      payload: { value: 'current' },
      retained: false,
    });
    await expect(registry.dispatch('/-/topic/get', { topic: 'missing-topic' })).resolves.toBeUndefined();
    expect((registry as any).topics.get('snapshot-topic')?.subscribers.size).toBe(0);
  });

  it('returns topic payload snapshots without exposing registry state by reference', async () => {
    const registry = new Registry(testAdvertise);
    const publisher = { host: '127.0.0.1', port: 3701 };

    await registry.dispatch('/-/declare', { topic: 'immutable-topic', payload: { nested: { value: 'current' } } }, {
      client: publisher,
    });

    const snapshot = await registry.dispatch('/-/topic/get', { topic: 'immutable-topic' });
    snapshot.payload.nested.value = 'mutated';

    await expect(registry.dispatch('/-/topic/get', { topic: 'immutable-topic' })).resolves.toMatchObject({
      payload: { nested: { value: 'current' } },
    });
  });
});

describe('@hile/micro application discovery', () => {
  it('reads registry topic snapshots without becoming a subscriber', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();
    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'registry-reader-publisher',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const consumer = new Application({
      namespace: 'registry-reader-consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const stopRegistry = await registry.listen(registryPort);
    const stopPublisher = await publisher.listen(publisherPort);
    const stopConsumer = await consumer.listen(consumerPort);
    const published = await publisher.publish('@hile/rsc/discovery/v1/fixture', { buildId: 'build-1' });

    try {
      await expect(consumer.listRegistryTopics('@hile/rsc/discovery/v1/')).resolves.toEqual([
        expect.objectContaining({
          topic: '@hile/rsc/discovery/v1/fixture',
          publisherCount: 1,
          subscriberCount: 0,
          hasData: true,
        }),
      ]);
      await expect(consumer.getRegistryTopic('@hile/rsc/discovery/v1/fixture')).resolves.toMatchObject({
        payload: { buildId: 'build-1' },
        subscriberCount: 0,
      });
      await expect(consumer.getRegistryTopic('@hile/rsc/discovery/v1/missing')).resolves.toBeUndefined();
    } finally {
      await published.unpublish();
      await stopConsumer();
      await stopPublisher();
      await stopRegistry();
    }
  });

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
      const result = await client.request<{ value: string }>('/echo', { value: 'ok' });
      expect(result).toEqual({ value: 'ok' });
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
      const result = await client.request('/x', {});
      expect(result).toEqual({ ok: true });
    } finally {
      unregister();
      await dispose2();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('does not reuse an in-flight registry reconnect from before re-listen', async () => {
    const registryPort = await getAvailablePort();
    const appPort1 = await getAvailablePort();
    const appPort2 = await getAvailablePort();
    const app = new ControlledReconnectApplication({
      namespace: 'stale-reconnect',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const dispose1 = await app.listen(appPort1);
    (app as any).registry.events.emit('disconnect');
    await app.connectStarted.promise;

    await dispose1();
    const listen2 = app.listen(appPort2);
    await new Promise(resolve => setTimeout(resolve, 20));
    app.releaseConnect.resolve();
    const dispose2 = await listen2;

    try {
      expect(app.announcedPorts).toEqual([appPort1, appPort1, appPort2]);
    } finally {
      await dispose2();
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
    } finally {
      await disposeApp();
      await disposeRegistry();
    }
  });

  it('disconnects client that stops sending heartbeats', async () => {
    // Speed up detection via env vars before creating connections
    process.env.MICRO_HEARTBEAT_INTERVAL = '30000'; // no hb in test window
    process.env.MICRO_HEARTBEAT_TIMEOUT = '2000';   // timeout after 2s
    process.env.MICRO_HEARTBEAT_CHECK_INTERVAL = '500'; // check every 500ms

    try {
      const registryPort = await getAvailablePort();
      const registry = new Registry(testAdvertise);
      const disposeRegistry = await registry.listen(registryPort);

      // A bare Server connected to Registry — its outbound Client
      // sends heartbeats on a 30s interval, but timeout is 2s.
      const silent = new Server('silent', testAdvertise);
      silent.setPort(1);
      await (silent as any).connect('127.0.0.1', registryPort);
      const entryKey = '127.0.0.1:1';

      try {
        // Wait for Registry-side inbound Client to detect timeout
        await waitForCondition(
          () => !(registry as any).clients.has(entryKey),
          'Registry-side inbound client should time out',
          3500,
        );
      } finally {
        await disposeRegistry();
      }
    } finally {
      delete process.env.MICRO_HEARTBEAT_INTERVAL;
      delete process.env.MICRO_HEARTBEAT_TIMEOUT;
      delete process.env.MICRO_HEARTBEAT_CHECK_INTERVAL;
    }
  });

  it('detects peer timeout and cleans up on provider side', async () => {
    process.env.MICRO_HEARTBEAT_INTERVAL = '30000';
    process.env.MICRO_HEARTBEAT_TIMEOUT = '2000';
    process.env.MICRO_HEARTBEAT_CHECK_INTERVAL = '500';

    try {
      const registryPort = await getAvailablePort();
      const providerPort = await getAvailablePort();
      const consumerPort = await getAvailablePort();

      const registry = new Registry(testAdvertise);
      const provider = new Application({
        namespace: 'peer-svc',
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

      const unregister = provider.register('/echo', async ({ data }: any) => {
        return { value: data.value };
      });

      try {
        // Establish consumer → provider connection
        const client = await consumer.get('peer-svc');
        const result = await client.request('/echo', { value: 'ok' });
        expect(result).toEqual({ value: 'ok' });

        // Verify provider has the consumer's Client
        const consumerClientKey = `127.0.0.1:${consumerPort}`;
        expect((provider as any).clients.has(consumerClientKey)).toBe(true);

        // Wait for timeout (consumer's Client sends at 30s, timeout 2s)
        // Extra buffer to ensure the >2000ms strict-greater check triggers
        await new Promise(r => setTimeout(r, 3000));

        // Provider should have disposed the consumer's Client
        expect((provider as any).clients.has(consumerClientKey)).toBe(false);
      } finally {
        unregister();
        await disposeConsumer();
        await disposeProvider();
        await disposeRegistry();
      }
    } finally {
      delete process.env.MICRO_HEARTBEAT_INTERVAL;
      delete process.env.MICRO_HEARTBEAT_TIMEOUT;
      delete process.env.MICRO_HEARTBEAT_CHECK_INTERVAL;
    }
  }, 10000);
});

describe('@hile/micro circuit breaker', () => {
  it('keeps a failing peer eligible until the failure threshold is reached', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('A fail');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ ok: true })));
    const app = new CircuitBreakerTestApplication([peerA, peerB]);

    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

    const result = await app.call('svc', '/api', {}, { retries: 0 });

    expect(result).toEqual({ ok: true });
    expect(peerA.request).toHaveBeenCalledTimes(3);
    expect(peerB.request).toHaveBeenCalledTimes(1);
    expect(app.lookupExcludes[0]).toEqual([]);
    expect(app.lookupExcludes[1]).toEqual([]);
    expect(app.lookupExcludes[2]).toEqual([]);
    expect(app.lookupExcludes[3]).toEqual(['127.0.0.1:1001']);
  });

  it('limits half-open probes and routes overflow to another peer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const probe = createDeferred<{ from: string }>();
    let peerAAttempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      peerAAttempts++;
      if (peerAAttempts === 1) throw new Error('A fail');
      return probe.promise;
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      const halfOpenProbe = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await Promise.resolve();

      const overflow = await app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      probe.resolve({ from: 'A' });
      await expect(halfOpenProbe).resolves.toEqual({ from: 'A' });

      expect(overflow).toEqual({ from: 'B' });
      expect(app.lookupExcludes.at(-1)).toEqual(['127.0.0.1:1001']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset a full half-open probe when no alternate peer exists', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const probe = createDeferred<{ from: string }>();
    const probeStarted = createDeferred<void>();
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('A fail');
      if (attempts === 2) {
        probeStarted.resolve();
        return probe.promise;
      }
      throw new Error('overflow called');
    }));
    const app = new CircuitBreakerTestApplication([peerA], {
      failureThreshold: 1,
      cooldownMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      const halfOpenProbe = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await probeStarted.promise;
      expect(peerA.request).toHaveBeenCalledTimes(2);

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow();
      expect(peerA.request).toHaveBeenCalledTimes(2);

      probe.resolve({ from: 'A' });
      await expect(halfOpenProbe).resolves.toEqual({ from: 'A' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset a full half-open probe returned by stale lookups', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const probe = createDeferred<{ from: string }>();
    const probeStarted = createDeferred<void>();
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('A fail');
      if (attempts === 2) {
        probeStarted.resolve();
        return probe.promise;
      }
      throw new Error('overflow called');
    }));
    const app = new StaleLookupCircuitBreakerTestApplication([peerA], {
      failureThreshold: 1,
      cooldownMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      const halfOpenProbe = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await probeStarted.promise;
      app.returnFirstPeerOnNextLookup();
      app.returnFirstPeerOnNextLookup();

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('Circuit breaker probe unavailable');
      expect(peerA.request).toHaveBeenCalledTimes(2);

      probe.resolve({ from: 'A' });
      await expect(halfOpenProbe).resolves.toEqual({ from: 'A' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rechecks half-open probe capacity after lookup races', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const probe = createDeferred<{ from: string }>();
    let peerAAttempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      peerAAttempts++;
      if (peerAAttempts === 1) throw new Error('A fail');
      return probe.promise;
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new DelayedGetCircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 100,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      app.delayNextLookups(2);
      const firstProbe = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      const racedLookup = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });

      expect(app.pausedLookups).toBe(2);
      app.releasePausedLookups();

      await expect(racedLookup).resolves.toEqual({ from: 'B' });
      probe.resolve({ from: 'A' });
      await expect(firstProbe).resolves.toEqual({ from: 'A' });
      expect(peerA.request).toHaveBeenCalledTimes(2);
      expect(peerB.request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reopens a failed half-open peer with exponential cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('A fail');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 1_000,
      halfOpenMaxProbes: 1,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.250Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'B' });

      vi.setSystemTime(new Date('2026-01-01T00:00:00.302Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      expect(peerA.request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let stale half-open success close a reopened peer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const delayedSuccess = createDeferred<{ from: string }>();
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('initial fail');
      if (attempts === 2) return delayedSuccess.promise;
      throw new Error('probe fail');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 1_000,
      halfOpenMaxProbes: 2,
      successThreshold: 2,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('initial fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      const staleSuccess = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await Promise.resolve();

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('probe fail');
      delayedSuccess.resolve({ from: 'A' });
      await expect(staleSuccess).resolves.toEqual({ from: 'A' });

      vi.setSystemTime(new Date('2026-01-01T00:00:00.250Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'B' });
      expect(app.lookupExcludes.at(-1)).toEqual(['127.0.0.1:1001']);
      expect(peerA.request).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let stale closed-state success close an opened peer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const staleSuccess = createDeferred<{ from: string }>();
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) return staleSuccess.promise;
      if (attempts === 2) throw new Error('A fail');
      return { from: 'A' };
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 100,
      successThreshold: 1,
    });

    try {
      const oldSuccess = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await Promise.resolve();

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      staleSuccess.resolve({ from: 'A' });
      await expect(oldSuccess).resolves.toEqual({ from: 'A' });

      vi.setSystemTime(new Date('2026-01-01T00:00:00.050Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'B' });
      expect(peerA.request).toHaveBeenCalledTimes(2);
      expect(peerB.request).toHaveBeenCalledTimes(1);
      expect(app.lookupExcludes.at(-1)).toEqual(['127.0.0.1:1001']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let stale closed-state failure extend an opened peer cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const staleFailure = createDeferred<{ from: string }>();
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) return staleFailure.promise;
      if (attempts === 2) throw new Error('A fail');
      return { from: 'A' };
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 1_000,
      successThreshold: 1,
    });

    try {
      const oldFailure = app.call<{ from: string }>('svc', '/api', {}, { retries: 0 });
      await Promise.resolve();

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      staleFailure.reject(new Error('late fail'));
      await expect(oldFailure).rejects.toThrow('late fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.150Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'A' });
      expect(peerA.request).toHaveBeenCalledTimes(3);
      expect(peerB.request).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call an open peer returned by a stale lookup', async () => {
    let attempts = 0;
    const peerA = createFakePeer(1001, vi.fn(async () => {
      attempts++;
      if (attempts === 1) throw new Error('A fail');
      return { from: 'A' };
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new StaleLookupCircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 10_000,
      successThreshold: 1,
    });

    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
    app.returnFirstPeerOnNextLookup();

    await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'B' });
    expect(peerA.request).toHaveBeenCalledTimes(1);
    expect(peerB.request).toHaveBeenCalledTimes(1);
    expect(app.lookupExcludes.at(-2)).toEqual(['127.0.0.1:1001']);
    expect(app.lookupExcludes.at(-1)).toEqual(['127.0.0.1:1001']);
  });

  it('does not reset an opened peer inside the same call retry', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('A fail');
    }));
    const app = new CircuitBreakerTestApplication([peerA], {
      failureThreshold: 1,
    });

    await expect(app.call('svc', '/api', {})).rejects.toThrow('A fail');

    expect(peerA.request).toHaveBeenCalledTimes(1);
    expect(app.lookupExcludes[1]).toEqual(['127.0.0.1:1001']);
  });

  it('forgets closed-state failures after the failure window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('A fail');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ ok: true })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 3,
      failureWindowMs: 100,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      vi.setSystemTime(new Date('2026-01-01T00:00:00.050Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.151Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      expect(peerB.request).not.toHaveBeenCalled();

      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ ok: true });
      expect(peerA.request).toHaveBeenCalledTimes(5);
      expect(peerB.request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not record failures rejected by shouldRecordFailure', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('business');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ ok: true })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      shouldRecordFailure: (err: unknown) => !(err instanceof Error && err.message === 'business'),
    });

    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('business');
    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('business');

    expect(peerA.request).toHaveBeenCalledTimes(2);
    expect(peerB.request).not.toHaveBeenCalled();
    expect(app.lookupExcludes[1]).toEqual([]);
  });

  it('does not retry failures rejected by shouldRetry', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('non-retryable');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ ok: true })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      shouldRetry: (err: unknown) => !(err instanceof Error && err.message === 'non-retryable'),
    });

    await expect(app.call('svc', '/api', {}, { retries: 3 })).rejects.toThrow('non-retryable');

    expect(peerA.request).toHaveBeenCalledTimes(1);
    expect(peerB.request).not.toHaveBeenCalled();
  });

  it('does not mask the original failure when shouldRecordFailure throws', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('peer fail');
    }));
    const app = new CircuitBreakerTestApplication([peerA], {
      failureThreshold: 1,
      shouldRecordFailure: () => {
        throw new Error('record hook fail');
      },
    });

    await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('peer fail');
  });

  it('does not mask the original failure when shouldRetry throws', async () => {
    const peerA = createFakePeer(1001, vi.fn(async () => {
      throw new Error('peer fail');
    }));
    const peerB = createFakePeer(1002, vi.fn(async () => ({ ok: true })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      shouldRetry: () => {
        throw new Error('retry hook fail');
      },
    });

    await expect(app.call('svc', '/api', {}, { retries: 3 })).rejects.toThrow('peer fail');
    expect(peerB.request).not.toHaveBeenCalled();
  });

  it('does not count a close-only half-open stream as a success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const peerA = createFakePeer(
      1001,
      vi.fn(async () => {
        throw new Error('A fail');
      }),
      vi.fn(() => new Readable({ objectMode: true, read() { } })),
    );
    const peerB = createFakePeer(1002, vi.fn(async () => ({ from: 'B' })));
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
      cooldownMs: 100,
      maxCooldownMs: 1_000,
      successThreshold: 1,
    });

    try {
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.101Z'));
      const halfOpenStream = await app.stream('svc', '/api', {}, { retries: 0 });
      const closed = new Promise<void>(resolve => halfOpenStream.once('close', () => resolve()));
      halfOpenStream.destroy();
      await closed;

      vi.setSystemTime(new Date('2026-01-01T00:00:00.150Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('A fail');

      vi.setSystemTime(new Date('2026-01-01T00:00:00.251Z'));
      await expect(app.call('svc', '/api', {}, { retries: 0 })).resolves.toEqual({ from: 'B' });
      expect(peerA.request).toHaveBeenCalledTimes(2);
      expect(peerB.request).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records asynchronous stream errors for circuit breaker routing', async () => {
    const peerA = createFakePeer(
      1001,
      vi.fn(),
      vi.fn(() => {
        const stream = new Readable({ objectMode: true, read() { } });
        queueMicrotask(() => stream.destroy(new Error('stream fail')));
        return stream;
      }),
    );
    const peerB = createFakePeer(
      1002,
      vi.fn(),
      vi.fn(() => Readable.from([{ ok: true }], { objectMode: true })),
    );
    const app = new CircuitBreakerTestApplication([peerA, peerB], {
      failureThreshold: 1,
    });

    const failingStream = await app.stream('svc', '/api', {}, { retries: 0 });
    await expect(async () => {
      for await (const _chunk of failingStream) {
        // consume until the stream reports its async failure
      }
    }).rejects.toThrow('stream fail');

    const recoveryStream = await app.stream('svc', '/api', {}, { retries: 0 });
    const chunks: any[] = [];
    for await (const chunk of recoveryStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([{ ok: true }]);
    expect(peerA.stream).toHaveBeenCalledTimes(1);
    expect(peerB.stream).toHaveBeenCalledTimes(1);
    expect(app.lookupExcludes.at(-1)).toEqual(['127.0.0.1:1001']);
  });

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
      circuitBreaker: { failureThreshold: 1 },
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
      circuitBreaker: { failureThreshold: 1 },
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

describe('@hile/micro health endpoint', () => {
  it('/-/health returns status and registry state', async () => {
    const registryPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const consumer = new Application({
      namespace: 'health-test',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeConsumer = await consumer.listen(consumerPort);

    try {
      const result: any = await consumer.dispatch('/-/health', {});
      expect(result).toBeDefined();
      expect(result.status).toBe('ok');
      expect(result.registry).toBe(true);
      expect(typeof result.uptime).toBe('number');
      expect(Array.isArray(result.namespaces)).toBe(true);
    } finally {
      await disposeConsumer();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro call retry', () => {
  it('retries on failure and succeeds on second peer', async () => {
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
      circuitBreaker: { failureThreshold: 1 },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeA = await providerA.listen(portA);
    const disposeConsumer = await consumer.listen(consumerPort);

    const unregisterA = providerA.register('/api', async () => {
      throw new Error('fail');
    });

    try {
      // Only A exists, A fails, retry also hits A (only option), also fails
      await expect(consumer.call('svc', '/api', {})).rejects.toThrow();

      // Now B exists and succeeds
      const disposeB = await providerB.listen(portB);
      const unregisterB = providerB.register('/api', async () => ({ ok: true }));

      // A is excluded from previous failure, retry should pick B
      const result = await consumer.call<{ ok: boolean }>('svc', '/api', {});
      expect(result).toEqual({ ok: true });

      unregisterB();
      await disposeB();
    } finally {
      unregisterA();
      await disposeConsumer();
      await disposeA();
      await disposeRegistry();
    }
  });

  it('respects retries=0 (no retry)', async () => {
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
    const unregister = provider.register('/api', async () => {
      throw new Error('no-retry');
    });

    try {
      await expect(consumer.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('no-retry');
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro cache degradation', () => {
  it('uses cached client when registry lookup fails due to exclusion', async () => {
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
      circuitBreaker: { failureThreshold: 1 },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/api', async () => ({ ok: true }));

    try {
      // First call establishes cache
      const result1 = await consumer.call('svc', '/api', {});
      expect(result1).toEqual({ ok: true });

      // Replace with failing handler
      unregister();
      const unregisterFail = provider.register('/api', async () => {
        throw new Error('fail');
      });

      // Call fails with retries=0; failure is recorded in circuit breaker
      await expect(consumer.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('fail');
      unregisterFail();

      // Re-register working handler
      const unregisterOk = provider.register('/api', async () => ({ ok: true }));

      // Second call: cached peer is excluded by circuit breaker → registry lookup
      // fails (find excludes the only peer) → cache degradation returns the
      // still-connected cached client → succeeds
      const result2 = await consumer.call('svc', '/api', {}, { retries: 0 });
      expect(result2).toEqual({ ok: true });

      unregisterOk();
    } finally {
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('keeps cached client when registry is unavailable and an open peer is reset', async () => {
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
      circuitBreaker: { failureThreshold: 1 },
      registryLookupTimeoutMs: 50,
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    let unregister: (() => void) | undefined = provider.register('/api', async () => ({ ok: true }));
    let registryDisposed = false;

    try {
      const result1 = await consumer.call('svc', '/api', {});
      expect(result1).toEqual({ ok: true });

      unregister();
      unregister = provider.register('/api', async () => {
        throw new Error('fail');
      });
      await expect(consumer.call('svc', '/api', {}, { retries: 0 })).rejects.toThrow('fail');

      unregister();
      unregister = provider.register('/api', async () => ({ ok: true }));

      await disposeRegistry();
      registryDisposed = true;
      await waitForCondition(
        () => !(consumer as any).registry,
        'consumer did not observe registry disconnect',
      );

      const result2 = await consumer.call('svc', '/api', {}, { retries: 0 });
      expect(result2).toEqual({ ok: true });
    } finally {
      unregister?.();
      await disposeConsumer();
      await disposeProvider();
      if (!registryDisposed) {
        await disposeRegistry();
      }
    }
  });
});


describe('@hile/micro request timeout', () => {
  it('rejects when request exceeds the timeout', async () => {
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
    const unregister = provider.register('/slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { value: 'too-late' };
    });

    try {
      // timeout=50ms but handler takes 500ms → rejects
      await expect(
        consumer.call('svc', '/slow', {}, { timeout: 50, retries: 0 })
      ).rejects.toThrow('Timeout');
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('succeeds when timeout is long enough', async () => {
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
      const result = await consumer.call<{ value: string }>('svc', '/echo', { value: 'ok' }, { timeout: 5000 });
      expect(result).toEqual({ value: 'ok' });
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro stream', () => {
  it('stream retries when get fails with exclude and resets circuit breaker', async () => {
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
      circuitBreaker: { failureThreshold: 1 },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeA = await providerA.listen(portA);
    const disposeConsumer = await consumer.listen(consumerPort);

    // A fails
    const unregisterA = providerA.register('/api', async () => {
      throw new Error('A fail');
    });

    let disposeB: () => Promise<void>;

    try {
      // call() first to register circuit breaker exclusion for A
      await expect(consumer.call('svc', '/api', {})).rejects.toThrow('A fail');

      // Now register B which succeeds
      disposeB = await providerB.listen(portB);
      const unregisterB = providerB.register('/api', async function* () {
        yield { ok: true };
      });

      // stream with circuit breaker active → get() with exclude fails
      // → catch resets breaker and retries → picks B → succeeds
      const readable = await consumer.stream('svc', '/api', {});
      const chunks: any[] = [];
      for await (const chunk of readable) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{ ok: true }]);

      unregisterB();
    } finally {
      unregisterA();
      await disposeConsumer();
      if (disposeB) await disposeB();
      await disposeA();
      await disposeRegistry();
    }
  });

  it('stream retries when get fails with exclude and resets circuit breaker', async () => {
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
      circuitBreaker: { failureThreshold: 1 },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeA = await providerA.listen(portA);
    const disposeConsumer = await consumer.listen(consumerPort);

    // Only A registered initially
    const unregisterA = providerA.register('/api', async () => {
      throw new Error('A fail');
    });

    let disposeB: () => Promise<void>;
    let unregisterB: () => void;

    try {
      // Only A is available → hits A → fails → circuit breaker excludes A
      await expect(consumer.call('svc', '/api', {})).rejects.toThrow('A fail');

      // Now register B (succeeds) and take A offline
      disposeB = await providerB.listen(portB);
      unregisterB = providerB.register('/api', async function* () {
        yield { ok: true };
      });

      await disposeA();
      // Allow close events to propagate (consumer removes A's client)
      await new Promise(r => setTimeout(r, 100));

      // stream() with circuit breaker excludes A → get() with exclude fails
      // → catch resets breaker and retries → picks B → succeeds
      const readable = await consumer.stream('svc', '/api', {});
      const chunks: any[] = [];
      for await (const chunk of readable) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{ ok: true }]);
    } finally {
      unregisterA();
      if (unregisterB) unregisterB();
      await disposeConsumer();
      if (disposeB) await disposeB();
      await disposeRegistry();
    }
  });

  it('streams chunks from provider', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'stream-svc',
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
    const unregister = provider.register('/stream', async function* () {
      yield { seq: 1 };
      yield { seq: 2 };
      yield { seq: 3 };
    });

    try {
      const stream = await consumer.stream('stream-svc', '/stream', {});
      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });

  it('handles stream error from provider', async () => {
    const registryPort = await getAvailablePort();
    const providerPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const provider = new Application({
      namespace: 'stream-svc',
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
    const unregister = provider.register('/stream', async function* () {
      yield { seq: 1 };
      throw new Error('stream fail');
    });

    try {
      const stream = await consumer.stream('stream-svc', '/stream', {});
      const chunks: any[] = [];
      await expect(async () => {
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
      }).rejects.toThrow('stream fail');
      expect(chunks).toEqual([{ seq: 1 }]);
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro address validation', () => {
  it('throws on empty registry host', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '', port: 3000 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on registry host with whitespace', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '127.0.0.1 ', port: 3000 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on IPv6 registry host without brackets', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '::1', port: 3000 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on registry host containing illegal characters', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '127.0.0.1/evil', port: 3000 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on registry port out of range (zero)', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '127.0.0.1', port: 0 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on oversized registry port', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '127.0.0.1', port: 65536 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });

  it('throws on non-integer registry port', () => {
    expect(() => new Application({
      namespace: 'test', registry: { host: '127.0.0.1', port: 12.5 }, ...testAdvertise,
    })).toThrow('Invalid registry address');
  });
});

describe('@hile/micro publish/subscribe edge cases', () => {
  it('publish throws when registry is not connected', async () => {
    const app = new Application({
      namespace: 'pub-test', registry: { host: '127.0.0.1', port: 1 }, ...testAdvertise,
    });
    await expect(app.publish('test-topic', {})).rejects.toThrow('Registry not found');
  });

  it('subscribe twice for same topic is idempotent and returns fallback', async () => {
    const registryPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const consumer = new Application({
      namespace: 'consumer',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeConsumer = await consumer.listen(consumerPort);

    try {
      const cb = vi.fn();
      const fallback1 = await consumer.subscribe('idempotent-topic', cb);
      expect(typeof fallback1).toBe('function');

      const fallback2 = await consumer.subscribe('idempotent-topic', cb);
      expect(typeof fallback2).toBe('function');
    } finally {
      await disposeConsumer();
      await disposeRegistry();
    }
  });

  it('publish after teardown throws Registry not found', async () => {
    const registryPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const consumer = new Application({
      namespace: 'pub-teardown',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeConsumer = await consumer.listen(consumerPort);

    await disposeConsumer();
    await expect(consumer.publish('post-teardown', {})).rejects.toThrow('Registry not found');
    await disposeRegistry();
  });

  it('publish to connected registry succeeds and returns ref', async () => {
    const registryPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const consumer = new Application({
      namespace: 'pub-success',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeConsumer = await consumer.listen(consumerPort);

    try {
      const ref = await consumer.publish('my-topic', { hello: 'world' });
      expect(ref).toHaveProperty('update');
      expect(ref).toHaveProperty('unpublish');

      // Update the topic payload
      await ref.update({ hello: 'updated' });

      // Unpublish the topic
      await ref.unpublish();
    } finally {
      await disposeConsumer();
      await disposeRegistry();
    }
  });

  it('delivers publish and update payloads to subscribers', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-delivery',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-delivery',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe('delivery-topic', value => received.push(value));

      const ref = await publisher.publish('delivery-topic', { value: 1 });
      await waitForCondition(() => received.length === 1, 'subscriber did not receive initial publish');
      expect(received).toEqual([{ value: 1 }]);

      await ref.update({ value: 2 });
      await waitForCondition(() => received.length === 2, 'subscriber did not receive update');
      expect(received).toEqual([{ value: 1 }, { value: 2 }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not replay a stale initial snapshot after a live update during subscribe', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'subscribe-live-update-topic';

    const registry = new UpdatingDuringSubscribeRegistry(topic, { value: 'latest' });
    const publisher = new Application({
      namespace: 'pub-subscribe-live-update',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-subscribe-live-update',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await publisher.publish(topic, { value: 'initial' });
      await subscriber.subscribe(topic, value => received.push(value));

      await waitForCondition(
        () => received.length === 1,
        'subscriber did not receive live update during subscribe',
      );
      expect(received).toEqual([{ value: 'latest' }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not notify subscribers when payload signature is unchanged', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-signature',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-signature',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe('signature-topic', value => received.push(value));

      const ref = await publisher.publish('signature-topic', { a: 1, b: 2 });
      await waitForCondition(() => received.length === 1, 'subscriber did not receive initial signed payload');

      await publisher.publish('signature-topic', { b: 2, a: 1 });
      await ref.update({ b: 2, a: 1 });
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(received).toEqual([{ a: 1, b: 2 }]);

      await ref.update({ a: 1, b: 3 });
      await waitForCondition(() => received.length === 2, 'subscriber did not receive changed signed payload');
      expect(received).toEqual([{ a: 1, b: 2 }, { a: 1, b: 3 }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not invoke subscriber for empty topics but preserves published undefined', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-undefined',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-undefined',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const cb = vi.fn();
      await subscriber.subscribe('undefined-topic', cb);
      expect(cb).not.toHaveBeenCalled();

      await publisher.publish('undefined-topic', undefined);
      await waitForCondition(() => cb.mock.calls.length === 1, 'subscriber did not receive published undefined');
      expect(cb).toHaveBeenCalledWith(undefined);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('subscribe and then call fallback to unsubscribe', async () => {
    const registryPort = await getAvailablePort();
    const consumerPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const consumer = new Application({
      namespace: 'sub-unsub',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeConsumer = await consumer.listen(consumerPort);

    try {
      const cb = vi.fn();
      const fallback = await consumer.subscribe('unsub-topic', cb);
      // Call fallback to unsubscribe — covers the /-/unsubscribe path
      await fallback();
    } finally {
      await disposeConsumer();
      await disposeRegistry();
    }
  });

  it('keeps built-in routes and subscriptions working after listen teardown and re-listen', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort1 = await getAvailablePort();
    const subscriberPort2 = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-relisten',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-relisten',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber1 = await subscriber.listen(subscriberPort1);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe('relisten-topic', value => received.push(value));
      await disposeSubscriber1();

      const disposeSubscriber2 = await subscriber.listen(subscriberPort2);
      try {
        await expect(subscriber.dispatch('/-/health', {})).resolves.toMatchObject({ status: 'ok' });
        const ref = await publisher.publish('relisten-topic', { value: 'after-relisten' });
        await waitForCondition(() => received.length === 1, 'subscriber did not receive after re-listen');
        expect(received).toEqual([{ value: 'after-relisten' }]);

        await ref.update({ value: 'updated-after-relisten' });
        await waitForCondition(() => received.length === 2, 'subscriber did not receive update after re-listen');
        expect(received).toEqual([
          { value: 'after-relisten' },
          { value: 'updated-after-relisten' },
        ]);
      } finally {
        await disposeSubscriber2();
      }
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('re-declares published topics after reconnecting to the registry', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-redeclare',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      await publisher.publish('redeclare-topic', { value: 'latest' });
      const publisherKey = `127.0.0.1:${publisherPort}`;
      expect((registry as any).topics.get('redeclare-topic').publishers.has(publisherKey)).toBe(true);

      const previousRegistryClient = (publisher as any).registry;
      (publisher as any).registry.dispose();
      await waitForCondition(
        () => (publisher as any).registry && (publisher as any).registry !== previousRegistryClient,
        'publisher did not reconnect to registry',
      );
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((registry as any).topics.get('redeclare-topic')?.publishers.has(publisherKey)).toBe(true);
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('restores subscriptions and latest published payload after registry restart', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-offline-restore',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-offline-restore',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    let disposeRestartedRegistry: (() => Promise<void>) | undefined;

    try {
      await disposeRegistry();
      await waitForCondition(
        () => !(publisher as any).registry && !(subscriber as any).registry,
        'applications did not observe registry disconnect',
      );

      const received: unknown[] = [];
      await subscriber.subscribe('offline-restore-topic', value => received.push(value));
      const ref = await publisher.publish('offline-restore-topic', { value: 'while-down' });
      await ref.update({ value: 'latest-while-down' });

      const restartedRegistry = new Registry(testAdvertise);
      disposeRestartedRegistry = await restartedRegistry.listen(registryPort);

      await waitForCondition(
        () => received.some(value => (value as any).value === 'latest-while-down'),
        'subscriber did not receive restored latest payload after registry restart',
        5000,
      );
      expect((restartedRegistry as any).topics.get('offline-restore-topic')?.publishers.has(`127.0.0.1:${publisherPort}`)).toBe(true);
      expect((restartedRegistry as any).topics.get('offline-restore-topic')?.subscribers.has(`127.0.0.1:${subscriberPort}`)).toBe(true);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      if (disposeRestartedRegistry) await disposeRestartedRegistry();
    }
  });

  it('restores pub/sub roles after the same registry instance is stopped and re-listened', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'same-registry-relisten-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-same-registry-relisten',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-same-registry-relisten',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    let disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe(topic, value => received.push(value));
      const ref = await publisher.publish(topic, { value: 'before-stop' });
      await waitForCondition(
        () => received.some(value => (value as any).value === 'before-stop'),
        'subscriber did not receive initial payload before registry relisten',
      );

      await disposeRegistry();
      await waitForCondition(
        () => !(publisher as any).registry && !(subscriber as any).registry,
        'applications did not observe same registry instance stop',
        3000,
      );
      await ref.update({ value: 'while-stopped' });

      disposeRegistry = await registry.listen(registryPort);
      await waitForCondition(() => {
        const entry = (registry as any).topics.get(topic);
        return entry?.data?.value === 'while-stopped' &&
          entry.publishers.has(`127.0.0.1:${publisherPort}`) &&
          entry.subscribers.has(`127.0.0.1:${subscriberPort}`) &&
          received.some(value => (value as any).value === 'while-stopped');
      }, 'pub/sub roles did not restore after same registry instance re-listen', 6000);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  }, 10_000);

  it('does not re-declare a topic that was unpublished while registry was down', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-offline-unpublish',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    let disposeRestartedRegistry: (() => Promise<void>) | undefined;

    try {
      const ref = await publisher.publish('offline-unpublish-topic', { value: 'active' });
      await waitForCondition(
        () => (registry as any).topics.get('offline-unpublish-topic')?.publishers.has(`127.0.0.1:${publisherPort}`),
        'publisher did not declare initial topic',
      );

      await disposeRegistry();
      await waitForCondition(
        () => !(publisher as any).registry,
        'publisher did not observe registry disconnect',
      );

      await ref.unpublish();

      const restartedRegistry = new Registry(testAdvertise);
      disposeRestartedRegistry = await restartedRegistry.listen(registryPort);
      await waitForCondition(
        () => !!(publisher as any).registry,
        'publisher did not reconnect to restarted registry',
        5000,
      );
      await new Promise(resolve => setTimeout(resolve, 100));

      expect((restartedRegistry as any).topics.has('offline-unpublish-topic')).toBe(false);
    } finally {
      await disposePublisher();
      if (disposeRestartedRegistry) await disposeRestartedRegistry();
    }
  });

  it('does not let reconnect declare resurrect a topic unpublished during reconnect', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'offline-race-unpublish-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-offline-race-unpublish',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    let disposeRestartedRegistry: (() => Promise<void>) | undefined;

    try {
      const ref = await publisher.publish(topic, { value: 'active' });
      await waitForCondition(
        () => (registry as any).topics.get(topic)?.publishers.has(`127.0.0.1:${publisherPort}`),
        'publisher did not declare initial topic',
      );

      await disposeRegistry();
      await waitForCondition(
        () => !(publisher as any).registry,
        'publisher did not observe registry disconnect',
      );

      const restartedRegistry = new DelayingDeclareRegistry(topic);
      disposeRestartedRegistry = await restartedRegistry.listen(registryPort);

      const reconnect = (publisher as any).reconnectToRegistry() as Promise<void>;
      reconnect.catch(() => undefined);
      await restartedRegistry.declareStarted.promise;

      const unpublish = ref.unpublish();
      await waitForCondition(
        () => !(publisher as any).publishedTopics.has(topic),
        'publisher did not clear local published topic',
      );
      expect((publisher as any).publishedTopics.has(topic)).toBe(false);

      restartedRegistry.releaseDeclare.resolve();
      await unpublish;
      await reconnect;

      expect((restartedRegistry as any).topics.has(topic)).toBe(false);
    } finally {
      await disposePublisher();
      if (disposeRestartedRegistry) await disposeRestartedRegistry();
    }
  });

  it('does not leave a stale subscriber when unsubscribed during reconnect restore', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'offline-race-unsubscribe-topic';

    const registry = new Registry(testAdvertise);
    const subscriber = new Application({
      namespace: 'sub-offline-race-unsubscribe',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    let disposeRestartedRegistry: (() => Promise<void>) | undefined;

    try {
      const fallback = await subscriber.subscribe(topic, vi.fn());
      await waitForCondition(
        () => (registry as any).topics.get(topic)?.subscribers.has(`127.0.0.1:${subscriberPort}`),
        'subscriber did not register initial topic',
      );

      await disposeRegistry();
      await waitForCondition(
        () => !(subscriber as any).registry,
        'subscriber did not observe registry disconnect',
      );

      const restartedRegistry = new DelayingSubscribeRegistry(topic);
      disposeRestartedRegistry = await restartedRegistry.listen(registryPort);

      const reconnect = (subscriber as any).reconnectToRegistry() as Promise<void>;
      reconnect.catch(() => undefined);
      await restartedRegistry.subscribeStarted.promise;

      const unsubscribe = fallback();
      await waitForCondition(
        () => !(subscriber as any).topics.has(topic),
        'subscriber did not clear local topic',
      );

      restartedRegistry.releaseSubscribe.resolve();
      await unsubscribe;
      await reconnect;

      expect((restartedRegistry as any).topics.has(topic)).toBe(false);
    } finally {
      await disposeSubscriber();
      if (disposeRestartedRegistry) await disposeRestartedRegistry();
    }
  });

  it('uses registry lookup timeout when initial subscribe snapshot hangs', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'subscribe-timeout-topic';

    const registry = new DelayingSubscribeRegistry(topic);
    const subscriber = new Application({
      namespace: 'sub-timeout',
      registry: { host: '127.0.0.1', port: registryPort },
      registryLookupTimeoutMs: 50,
      ...testAdvertise,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
      } as any,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const fallback = await Promise.race([
        subscriber.subscribe(topic, vi.fn()),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('subscribe did not respect registry lookup timeout')), 250)),
      ]);
      expect(typeof fallback).toBe('function');
    } finally {
      registry.releaseSubscribe.resolve();
      await disposeSubscriber();
      await disposeRegistry();
    }
  });

  it('does not treat disabled registry lookup timeout as an immediate publish timeout', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'publish-timeout-disabled-topic';

    const registry = new DelayingDeclareRegistry(topic);
    const publisher = new Application({
      namespace: 'pub-timeout-disabled',
      registry: { host: '127.0.0.1', port: registryPort },
      registryLookupTimeoutMs: 0,
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const publish = publisher.publish(topic, { value: 'waits' });
      await registry.declareStarted.promise;

      const early = await Promise.race([
        publish.then(() => 'resolved' as const),
        new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(early).toBe('pending');

      registry.releaseDeclare.resolve();
      await publish;
    } finally {
      registry.releaseDeclare.resolve();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not treat disabled registry lookup timeout as an immediate subscribe timeout', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'subscribe-timeout-disabled-topic';

    const registry = new DelayingSubscribeRegistry(topic);
    const subscriber = new Application({
      namespace: 'sub-timeout-disabled',
      registry: { host: '127.0.0.1', port: registryPort },
      registryLookupTimeoutMs: 0,
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const subscribe = subscriber.subscribe(topic, vi.fn());
      await registry.subscribeStarted.promise;

      const early = await Promise.race([
        subscribe.then(() => 'resolved' as const),
        new Promise<'pending'>(resolve => setTimeout(() => resolve('pending'), 50)),
      ]);
      expect(early).toBe('pending');

      registry.releaseSubscribe.resolve();
      await subscribe;
    } finally {
      registry.releaseSubscribe.resolve();
      await disposeSubscriber();
      await disposeRegistry();
    }
  });

  it('rejects non-serializable publish payloads without retaining publish intent', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'non-serializable-publish-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-non-serializable',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      await expect(publisher.publish(topic, { value: 1n })).rejects.toThrow();
      expect((publisher as any).publishedTopics.has(topic)).toBe(false);
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('rejects non-serializable update payloads without replacing the last valid publish intent', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'non-serializable-update-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-update-non-serializable',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const ref = await publisher.publish(topic, { value: 'valid' });
      await expect(ref.update({ value: 1n } as any)).rejects.toThrow();
      expect((publisher as any).publishedTopics.get(topic)).toEqual({ value: 'valid' });
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('delivers topic updates to later callbacks when an earlier callback throws', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-callback-isolation',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-callback-isolation',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
      } as any,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe('callback-isolation-topic', () => {
        throw new Error('first callback failed');
      });
      await subscriber.subscribe('callback-isolation-topic', value => received.push(value));

      await publisher.publish('callback-isolation-topic', { value: 'delivered' });
      await waitForCondition(
        () => received.length === 1,
        'later subscriber callback did not receive update after earlier callback threw',
      );
      expect(received).toEqual([{ value: 'delivered' }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('delivers isolated payload snapshots to callbacks on the same topic', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'callback-payload-isolation-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-callback-payload-isolation',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-callback-payload-isolation',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      await subscriber.subscribe(topic, (value: any) => {
        value.nested.count = 99;
      });
      await subscriber.subscribe(topic, value => received.push(value));

      await publisher.publish(topic, { nested: { count: 1 } });
      await waitForCondition(
        () => received.length === 1,
        'second callback did not receive payload after first callback mutation',
      );

      expect(received).toEqual([{ nested: { count: 1 } }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not leave a stale subscriber when duplicate unsubscribe happens during initial subscribe', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'initial-subscribe-race-topic';

    const registry = new DelayingSubscribeRegistry(topic);
    const subscriber = new Application({
      namespace: 'sub-initial-race',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const callback = vi.fn();
      const firstSubscribe = subscriber.subscribe(topic, callback);
      await registry.subscribeStarted.promise;

      const duplicateUnsubscribe = await subscriber.subscribe(topic, callback);
      const unsubscribe = duplicateUnsubscribe();
      await waitForCondition(
        () => !(subscriber as any).topics.has(topic),
        'subscriber did not clear local topic during initial subscribe race',
      );

      registry.releaseSubscribe.resolve();
      await firstSubscribe;
      await unsubscribe;

      expect((registry as any).topics.has(topic)).toBe(false);
    } finally {
      registry.releaseSubscribe.resolve();
      await disposeSubscriber();
      await disposeRegistry();
    }
  });

  it('keeps a fresh subscription when a prior unsubscribe finishes later', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const topic = 'unsubscribe-resubscribe-race-topic';

    const registry = new DelayingUnsubscribeRegistry(topic);
    const publisher = new Application({
      namespace: 'pub-unsubscribe-resubscribe-race',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-unsubscribe-resubscribe-race',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const unsubscribe = await subscriber.subscribe(topic, vi.fn());
      const pendingUnsubscribe = unsubscribe();
      await registry.unsubscribeStarted.promise;

      const received: unknown[] = [];
      const freshSubscribe = subscriber.subscribe(topic, value => received.push(value));
      await new Promise(resolve => setTimeout(resolve, 20));

      registry.releaseUnsubscribe.resolve();
      await freshSubscribe;
      await pendingUnsubscribe;

      await publisher.publish(topic, { value: 'fresh' });
      await waitForCondition(
        () => received.length === 1,
        'fresh subscription was removed by an older unsubscribe',
      );
      expect(received).toEqual([{ value: 'fresh' }]);
    } finally {
      registry.releaseUnsubscribe.resolve();
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not replay unpublished data to later subscribers while earlier subscribers remain', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();
    const lateSubscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-retired-topic',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-retired-topic',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const lateSubscriber = new Application({
      namespace: 'late-sub-retired-topic',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);
    const disposeLateSubscriber = await lateSubscriber.listen(lateSubscriberPort);

    try {
      const firstReceived: unknown[] = [];
      await subscriber.subscribe('retired-topic', value => firstReceived.push(value));

      const ref = await publisher.publish('retired-topic', { value: 'active' });
      await waitForCondition(() => firstReceived.length === 1, 'first subscriber did not receive active payload');

      await ref.unpublish();

      const lateReceived: unknown[] = [];
      await lateSubscriber.subscribe('retired-topic', value => lateReceived.push(value));
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(lateReceived).toEqual([]);
    } finally {
      await disposeLateSubscriber();
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('replays the remaining publisher payload after the latest publisher unpublishes', async () => {
    const registryPort = await getAvailablePort();
    const publisherPortA = await getAvailablePort();
    const publisherPortB = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisherA = new Application({
      namespace: 'pub-topic-a',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const publisherB = new Application({
      namespace: 'pub-topic-b',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-topic-after-unpublish',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisherA = await publisherA.listen(publisherPortA);
    const disposePublisherB = await publisherB.listen(publisherPortB);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      await publisherB.publish('multi-publisher-topic', { value: 'from-b' });
      const refA = await publisherA.publish('multi-publisher-topic', { value: 'from-a' });
      await refA.unpublish();

      const received: unknown[] = [];
      await subscriber.subscribe('multi-publisher-topic', value => received.push(value));

      expect(received).toEqual([{ value: 'from-b' }]);
    } finally {
      await disposeSubscriber();
      await disposePublisherB();
      await disposePublisherA();
      await disposeRegistry();
    }
  });

  it('does not reuse an older declare revision for a newer queued update', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'queued-update-revision-topic';

    const registry = new DelayingNthDeclareRegistry(topic, 2);
    const publisher = new Application({
      namespace: 'pub-queued-update-revision',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const ref = await publisher.publish(topic, { value: 'base' });
      const firstUpdate = ref.update({ value: 'first' });
      await registry.declareStarted.promise;

      const secondUpdate = ref.update({ value: 'second' });
      registry.releaseDeclare.resolve();

      await firstUpdate;
      await secondUpdate;

      expect(registry.declarations.map(({ payload }) => payload)).toEqual([
        { value: 'base' },
        { value: 'first' },
        { value: 'second' },
      ]);
      expect(registry.declarations[2]?.revision).toBeUndefined();
      expect((publisher as any).publishedTopicRevisions.get(topic)).toBeGreaterThan(
        (registry.declarations[1]?.revision ?? 0),
      );
    } finally {
      registry.releaseDeclare.resolve();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('restores the published payload snapshot instead of later object mutations', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'published-payload-snapshot-topic';

    let registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-payload-snapshot',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    let disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const payload = { value: 'original', nested: { count: 1 } };
      await publisher.publish(topic, payload);

      payload.value = 'mutated';
      payload.nested.count = 2;

      await disposeRegistry();
      await waitForCondition(
        () => !(publisher as any).registry,
        'publisher did not observe registry restart before payload snapshot restore',
        3000,
      );

      registry = new Registry(testAdvertise);
      disposeRegistry = await registry.listen(registryPort);

      await waitForCondition(() => {
        const entry = (registry as any).topics.get(topic);
        return entry?.data?.value === 'original' && entry.data.nested.count === 1;
      }, 'registry restored a mutated publish payload instead of the original snapshot', 6000);
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  }, 10_000);

  it('does not let an older publish ref unpublish a newer publish on the same topic', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'stale-publish-ref-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-stale-ref',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const staleRef = await publisher.publish(topic, { value: 'old' });
      await publisher.publish(topic, { value: 'new' });

      await staleRef.unpublish();

      const entry = (registry as any).topics.get(topic);
      expect(entry?.hasData).toBe(true);
      expect(entry?.data).toEqual({ value: 'new' });
      expect(entry?.publishers.has(`127.0.0.1:${publisherPort}`)).toBe(true);
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('does not let an older publish ref update a newer publish on the same topic', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const topic = 'stale-publish-ref-update-topic';

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-stale-update-ref',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);

    try {
      const staleRef = await publisher.publish(topic, { value: 'old' });
      await publisher.publish(topic, { value: 'new' });

      await staleRef.update({ value: 'stale-update' });

      const entry = (registry as any).topics.get(topic);
      expect(entry?.hasData).toBe(true);
      expect(entry?.data).toEqual({ value: 'new' });
    } finally {
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('restores the latest publisher payload by revision when redeclarations arrive out of order', async () => {
    const topic = 'revision-restored-topic';
    const registry = new Registry(testAdvertise);

    await registry.dispatch(
      '/-/declare',
      { topic, payload: { value: 'newer' }, revision: 200 },
      { client: { host: '127.0.0.1', port: 1 } as any },
    );
    await registry.dispatch(
      '/-/declare',
      { topic, payload: { value: 'older' }, revision: 100 },
      { client: { host: '127.0.0.1', port: 2 } as any },
    );

    const snapshot = await registry.dispatch(
      '/-/subscribe',
      { topic },
      { client: { host: '127.0.0.1', port: 3 } as any },
    );

    expect(snapshot).toEqual({ hasData: true, payload: { value: 'newer' } });
  });

  it('keeps publisher payload ownership when using the legacy topic update route', async () => {
    const topic = 'legacy-topic-update-ownership';
    const registry = new Registry(testAdvertise);
    const publisherA = { host: '127.0.0.1', port: 1 } as any;
    const publisherB = { host: '127.0.0.1', port: 2 } as any;
    const subscriber = { host: '127.0.0.1', port: 3 } as any;

    await registry.dispatch('/-/declare', { topic, payload: { value: 'a-old' } }, { client: publisherA });
    await registry.dispatch('/-/declare', { topic, payload: { value: 'b' } }, { client: publisherB });
    await registry.dispatch('/-/topic/update', { topic, payload: { value: 'a-new' } }, { client: publisherA });
    await registry.dispatch('/-/undeclare', { topic }, { client: publisherB });

    const snapshot = await registry.dispatch('/-/subscribe', { topic }, { client: subscriber });

    expect(snapshot).toEqual({ hasData: true, payload: { value: 'a-new' } });
  });

  it('restores publisher and subscriber roles with correct data after service and registry restarts', async () => {
    const registryPort = await getAvailablePort();
    const publisherPortA = await getAvailablePort();
    const publisherPortB = await getAvailablePort();
    const subscriberPortA = await getAvailablePort();
    const subscriberPortB = await getAvailablePort();
    const topic = 'role-restore-topic';
    const olderPayload = { owner: 'B', revision: 1 };
    const newerPayload = { owner: 'A', revision: 2 };

    let registry = new Registry(testAdvertise);
    const publisherA = new Application({
      namespace: 'role-publisher-a',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const publisherB = new Application({
      namespace: 'role-publisher-b',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriberA = new Application({
      namespace: 'role-subscriber-a',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriberB = new Application({
      namespace: 'role-subscriber-b',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    let disposeRegistry = await registry.listen(registryPort);
    let disposePublisherA = await publisherA.listen(publisherPortA);
    let disposePublisherB = await publisherB.listen(publisherPortB);
    let disposeSubscriberA = await subscriberA.listen(subscriberPortA);
    const disposeSubscriberB = await subscriberB.listen(subscriberPortB);

    try {
      const receivedA: unknown[] = [];
      const receivedB: unknown[] = [];
      await subscriberA.subscribe(topic, value => receivedA.push(value));
      await subscriberB.subscribe(topic, value => receivedB.push(value));

      await publisherB.publish(topic, olderPayload);
      await waitForCondition(
        () => receivedA.some(value => (value as any).owner === 'B') && receivedB.some(value => (value as any).owner === 'B'),
        'subscribers did not receive older publisher payload',
      );
      await publisherA.publish(topic, newerPayload);
      await waitForCondition(
        () => receivedA.some(value => (value as any).owner === 'A') && receivedB.some(value => (value as any).owner === 'A'),
        'subscribers did not receive newer publisher payload',
      );

      await disposeSubscriberA();
      disposeSubscriberA = await subscriberA.listen(subscriberPortA);
      await waitForCondition(
        () => receivedA.filter(value => (value as any).owner === 'A').length >= 2,
        'subscriber did not restore subscription after restart',
        3000,
      );

      await disposePublisherB();
      disposePublisherB = await publisherB.listen(publisherPortB);
      await waitForCondition(
        () => (registry as any).topics.get(topic)?.data?.owner === 'A',
        'older publisher restart replaced newer payload',
        3000,
      );

      await disposePublisherA();
      await waitForCondition(
        () => (registry as any).topics.get(topic)?.data?.owner === 'B',
        'registry did not fall back to remaining publisher payload',
        3000,
      );
      disposePublisherA = await publisherA.listen(publisherPortA);
      await waitForCondition(
        () => (registry as any).topics.get(topic)?.data?.owner === 'A',
        'newer publisher did not restore payload after restart',
        3000,
      );

      await disposeRegistry();
      await waitForCondition(
        () => !(publisherA as any).registry && !(publisherB as any).registry && !(subscriberA as any).registry && !(subscriberB as any).registry,
        'applications did not observe registry restart',
        3000,
      );
      registry = new Registry(testAdvertise);
      disposeRegistry = await registry.listen(registryPort);

      await waitForCondition(() => {
        const entry = (registry as any).topics.get(topic);
        return entry?.data?.owner === 'A' &&
          entry.publishers.has(`127.0.0.1:${publisherPortA}`) &&
          entry.publishers.has(`127.0.0.1:${publisherPortB}`) &&
          entry.subscribers.has(`127.0.0.1:${subscriberPortA}`) &&
          entry.subscribers.has(`127.0.0.1:${subscriberPortB}`);
      }, 'roles and latest payload did not restore after registry restart', 6000);
    } finally {
      await disposeSubscriberB();
      await disposeSubscriberA();
      await disposePublisherB();
      await disposePublisherA();
      await disposeRegistry();
    }
  });

  it('replays latest topic data when subscriptions are restored on reconnect', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-replay',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-replay',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const received: unknown[] = [];
      const callback = (value: unknown) => received.push(value);
      await publisher.publish('replay-topic', { value: 'initial' });
      await subscriber.subscribe('replay-topic', callback);
      expect(received).toEqual([{ value: 'initial' }]);

      const entry = (registry as any).topics.get('replay-topic');
      entry.data = { value: 'latest' };
      entry.hasData = true;
      received.length = 0;
      await (subscriber as any).subscribe('replay-topic', callback, true);
      expect(received).toEqual([{ value: 'latest' }]);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('keeps restored subscriptions when replay callback throws during reconnect', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-replay-error',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-replay-error',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
      } as any,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      await publisher.publish('replay-error-topic', { value: 'current' });
      const callback = vi.fn(() => {
        throw new Error('replay failed');
      });

      await expect((subscriber as any).subscribe('replay-error-topic', callback, true)).resolves.toBeTypeOf('function');
      expect(callback).toHaveBeenCalledWith({ value: 'current' });
      expect((registry as any).topics.get('replay-error-topic')?.subscribers.has(`127.0.0.1:${subscriberPort}`)).toBe(true);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('cleans up topic when the last subscriber unsubscribes and there are no publishers', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const subscriber = new Application({
      namespace: 'sub-cleanup',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const fallback = await subscriber.subscribe('cleanup-topic', vi.fn());
      expect((registry as any).topics.has('cleanup-topic')).toBe(true);

      await fallback();
      expect((registry as any).topics.has('cleanup-topic')).toBe(false);
    } finally {
      await disposeSubscriber();
      await disposeRegistry();
    }
  });

  it('registers one listener when the same callback subscribes concurrently', async () => {
    const registryPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const subscriber = new Application({
      namespace: 'sub-race',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      const cb = vi.fn();
      await Promise.all([
        subscriber.subscribe('race-topic', cb),
        subscriber.subscribe('race-topic', cb),
      ]);

      expect(subscriber.events.listenerCount('topic:race-topic')).toBe(1);
    } finally {
      await disposeSubscriber();
      await disposeRegistry();
    }
  });

  it('rolls back registry subscription when initial replay callback throws', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub-callback-error',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub-callback-error',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      await publisher.publish('callback-error-topic', { value: 1 });
      await expect(
        subscriber.subscribe('callback-error-topic', () => {
          throw new Error('callback failed');
        }),
      ).rejects.toThrow('callback failed');

      const subscriberKey = `127.0.0.1:${subscriberPort}`;
      expect(subscriber.events.listenerCount('topic:callback-error-topic')).toBe(0);
      expect(
        (registry as any).topics.get('callback-error-topic')?.subscribers.has(subscriberKey),
      ).toBe(false);
    } finally {
      await disposeSubscriber();
      await disposePublisher();
      await disposeRegistry();
    }
  });

  it('withTimeout with ms=0 skips timeout race', async () => {
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
      registryLookupTimeoutMs: 0,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeProvider = await provider.listen(providerPort);
    const disposeConsumer = await consumer.listen(consumerPort);
    const unregister = provider.register('/echo', async ({ data }: any) => ({ value: data.value }));

    try {
      const client = await consumer.get('svc');
      const result = await client.request('/echo', { value: 'ok' });
      expect(result).toEqual({ value: 'ok' });
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro server edge cases', () => {
  it('handleUpgrade throws when wss is not initialized', () => {
    const server = new Server('test-portal', testAdvertise);
    expect(() => server.handleUpgrade({} as any, {} as any, Buffer.alloc(0))).toThrow(
      'WebSocket server not initialized',
    );
  });

  it('listen(0) creates WebSocketServer with noServer option', async () => {
    const server = new Server('test-noserver', testAdvertise);
    const teardown = await server.listen(0);
    expect((server as any).wss).toBeDefined();
    await teardown();
  });

  it('wss.close error during listen teardown is propagated', async () => {
    const server = new Server('test-closeerr', testAdvertise);
    const port = await getAvailablePort();
    const teardown = await server.listen(port);

    const wss = (server as any).wss;
    const originalClose = wss.close.bind(wss);
    wss.close = (cb: (err?: Error) => void) => {
      cb(new Error('close fail'));
    };

    await expect(teardown()).rejects.toThrow('close fail');
  });
});

describe('@hile/micro client edge cases', () => {
  it('request throws when _online is false', async () => {
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
    const unregister = provider.register('/echo', async ({ data }: any) => ({ value: data.value }));

    try {
      const client = await consumer.get('svc');
      // Simulate offline state to test the _online guard in request/push/stream
      // (actual disconnect event from ws close is async and timing-dependent)
      (client as any)._online = false;

      expect(() => client.request('/echo', {})).toThrow('Client is not online');
      expect(() => client.push('/echo', {})).toThrow('Client is not online');
      expect(() => client.stream('/echo', {})).toThrow('Client is not online');
    } finally {
      unregister();
      await disposeConsumer();
      await disposeProvider();
      await disposeRegistry();
    }
  });
});

describe('@hile/micro registry utility functions', () => {
  it('parseConfigFilename returns null for non-config files', () => {
    expect(parseConfigFilename('test.txt')).toBeNull();
    expect(parseConfigFilename('config.yaml')).toBeNull();
  });

  it('parseConfigFilename extracts namespace from .config.yaml filename', () => {
    expect(parseConfigFilename('myapp.config.yaml')).toBe('myapp');
    expect(parseConfigFilename('my.namespace.config.yaml')).toBe('my.namespace');
  });
});

describe('@hile/micro registry topic cleanup', () => {
  it('cleans old topic roles when the same host and port reconnects before close cleanup', async () => {
    const registryPort = await getAvailablePort();
    const servicePort = await getAvailablePort();
    const topic = 'same-key-reconnect-cleanup-topic';
    const key = `127.0.0.1:${servicePort}`;

    const registry = new Registry(testAdvertise);
    const disposeRegistry = await registry.listen(registryPort);
    const ws1 = new WebSocket(`ws://127.0.0.1:${registryPort}/127.0.0.1/${servicePort}/old-service`);

    try {
      await new Promise<void>((resolve, reject) => {
        ws1.once('open', () => resolve());
        ws1.once('error', reject);
      });
      const client1 = (registry as any).clients.get(key);
      await registry.dispatch('/-/subscribe', { topic }, { client: client1 });
      expect((registry as any).topics.get(topic)?.subscribers.has(key)).toBe(true);

      const ws2 = new WebSocket(`ws://127.0.0.1:${registryPort}/127.0.0.1/${servicePort}/new-service`);
      await new Promise<void>((resolve, reject) => {
        ws2.once('open', () => resolve());
        ws2.once('error', reject);
      });

      await waitForCondition(
        () => (registry as any).clients.get(key) !== client1,
        'registry did not replace same-key client',
      );
      expect((registry as any).topics.has(topic)).toBe(false);

      ws2.close();
      await new Promise<void>((resolve) => ws2.once('close', () => resolve()));
    } finally {
      if (ws1.readyState === WebSocket.OPEN || ws1.readyState === WebSocket.CONNECTING) {
        ws1.close();
      }
      await disposeRegistry();
    }
  });

  it('removes topic data after all publishers and subscribers disconnect', async () => {
    const registryPort = await getAvailablePort();
    const publisherPort = await getAvailablePort();
    const subscriberPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const publisher = new Application({
      namespace: 'pub',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });
    const subscriber = new Application({
      namespace: 'sub',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposePublisher = await publisher.listen(publisherPort);
    const disposeSubscriber = await subscriber.listen(subscriberPort);

    try {
      // Publisher declares topic with data
      await publisher.publish('persist:topic', { key: 'should-survive' });

      // Subscriber subscribes and gets the data
      const cb = vi.fn();
      const fallback = await subscriber.subscribe<{ key: string }>('persist:topic', cb);
      expect(cb).toHaveBeenCalledWith({ key: 'should-survive' });

      // Disconnect both publisher and subscriber
      await fallback();
      await disposePublisher();
      await disposeSubscriber();
      // Allow disconnect events to propagate
      await new Promise(r => setTimeout(r, 100));

      // Topic should be removed once nobody publishes or subscribes to it.
      expect((registry as any).topics.has('persist:topic')).toBe(false);
    } finally {
      await disposeRegistry();
    }
  });
});

describe('@hile/micro application teardown', () => {
  it('disposes registry client on teardown', async () => {
    const registryPort = await getAvailablePort();
    const appPort = await getAvailablePort();

    const registry = new Registry(testAdvertise);
    const app = new Application({
      namespace: 'td',
      registry: { host: '127.0.0.1', port: registryPort },
      ...testAdvertise,
    });

    const disposeRegistry = await registry.listen(registryPort);
    const disposeApp = await app.listen(appPort);

    const appKey = `127.0.0.1:${appPort}`;
    expect((registry as any).clients.has(appKey)).toBe(true);

    await disposeApp();
    await new Promise(r => setTimeout(r, 100));

    // Registry client should be removed after teardown
    expect((registry as any).clients.has(appKey)).toBe(false);

    await disposeRegistry();
  });
});
