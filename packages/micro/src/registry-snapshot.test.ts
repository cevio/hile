import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Application } from './application';
import { Registry, type RegistrySnapshot } from './registry';

const testDirectory = `/tmp/registry-snapshot-test-${process.pid}-${Date.now()}`;
const advertise = { advertiseHost: '127.0.0.1' };

vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(),
  homedir: () => testDirectory,
}));

afterAll(() => rmSync(testDirectory, { recursive: true, force: true }));

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (!address || typeof address === 'string') throw new Error('Unable to allocate test port');
  return address.port;
}

describe('Registry metadata snapshots', () => {
  it('returns detached, sorted topology and config indexes without reading payloads', async () => {
    const configsDirectory = join(testDirectory, '.registry', 'configs');
    mkdirSync(configsDirectory, { recursive: true });
    writeFileSync(join(configsDirectory, 'fixture.config.yaml'), 'database:\n  password: secret-password\n');
    const registry = new Registry(advertise);
    const watcher = registry.watchEnvFile();
    const publisher = { host: '127.0.0.1', port: 3101 };
    const subscriber = { host: '[::1]', port: 3102 };

    try {
      registry.events.emit('connect', { ...publisher, events: new EventEmitter() }, ['publisher']);
      registry.events.emit('connect', { ...subscriber, events: new EventEmitter() }, ['subscriber']);
      registry.events.emit('connect', { ...subscriber, events: new EventEmitter() }, ['subscriber-alias']);
      await registry.dispatch('/-/declare', {
        topic: 'application.secret',
        payload: { token: 'secret-token' },
      }, { client: publisher });
      await registry.dispatch('/-/subscribe', { topic: 'application.secret' }, { client: subscriber });
      await registry.dispatch('/-/subscribe', { topic: 'application.secret' }, { client: subscriber });
      await registry.dispatch('/-/subscribe', { topic: 'empty.topic' }, { client: subscriber });

      const before = Date.now();
      const snapshot: RegistrySnapshot = await registry.dispatch('/-/registry/snapshot', {});
      expect(snapshot.observedAt).toBeGreaterThanOrEqual(before);
      expect(snapshot.observedAt).toBeLessThanOrEqual(Date.now());
      expect(snapshot.uptime).toBe(snapshot.observedAt - snapshot.startedAt);
      expect(snapshot).toMatchObject({
        status: 'ok',
        namespaceCount: 3,
        topicCount: 3,
        configNamespaceCount: 1,
        namespaces: [
          { namespace: 'publisher', peerCount: 1, peers: [publisher] },
          { namespace: 'subscriber', peerCount: 1, peers: [subscriber] },
          { namespace: 'subscriber-alias', peerCount: 1, peers: [subscriber] },
        ],
        configs: [{ namespace: 'fixture', keys: ['database'] }],
      });
      expect(snapshot.topics).toEqual([
        {
          topic: 'application.secret',
          publisherCount: 1,
          subscriberCount: 1,
          publishers: [publisher],
          subscribers: [subscriber],
          hasData: true,
          retained: false,
        },
        {
          topic: 'empty.topic',
          publisherCount: 0,
          subscriberCount: 1,
          publishers: [],
          subscribers: [subscriber],
          hasData: false,
          retained: false,
        },
        {
          topic: 'registry:fixture/database',
          publisherCount: 0,
          subscriberCount: 0,
          publishers: [],
          subscribers: [],
          hasData: true,
          retained: true,
        },
      ]);
      expect(JSON.stringify(snapshot)).not.toMatch(/secret-password|secret-token|payload/);

      snapshot.topics[0].subscribers[0].host = 'mutated';
      snapshot.namespaces[0].peers.length = 0;
      snapshot.configs[0].keys.length = 0;
      const next: RegistrySnapshot = await registry.dispatch('/-/registry/snapshot', {});
      expect(next.topics[0].subscribers).toEqual([subscriber]);
      expect(next.namespaces[0].peers).toEqual([publisher]);
      expect(next.configs[0].keys).toEqual(['database']);

      await expect(registry.dispatch('/-/topic/snapshots', { prefix: 'application.' })).resolves.toEqual({
        topics: [expect.objectContaining({
          payload: { token: 'secret-token' },
          publishers: [publisher],
          subscribers: [subscriber],
        })],
      });
    } finally {
      watcher.close();
      rmSync(configsDirectory, { recursive: true, force: true });
    }
  });

  it('observes real replica subscriptions, unsubscribe, disconnect and reconnect without subscribing the observer', async () => {
    const registry = new Registry(advertise);
    const registryPort = await getAvailablePort();
    const stopRegistry = await registry.listen(registryPort);
    const stops: Array<() => Promise<void>> = [];
    const start = async (namespace: string) => {
      const application = new Application({
        namespace,
        registry: { host: '127.0.0.1', port: registryPort },
        ...advertise,
      });
      stops.push(await application.listen(await getAvailablePort()));
      return application;
    };

    try {
      const publisher = await start('publisher');
      const first = await start('consumer');
      const second = await start('consumer');
      const observer = await start('observer');
      const topic = 'variables.database';
      const publication = await publisher.publish(topic, { password: 'private-value' });
      const unsubscribeFirst = await first.subscribe(topic, vi.fn());
      const unsubscribeSecond = await second.subscribe(topic, vi.fn());
      const findTopic = async () => (await observer.getRegistrySnapshot()).topics.find(entry => entry.topic === topic);
      const replicas = [first, second]
        .map(application => {
          if (application.port === undefined) throw new Error('Expected a listening Application');
          return { host: application.host, port: application.port };
        })
        .sort((a, b) => a.port - b.port);

      const snapshot = await observer.getRegistrySnapshot();
      expect(snapshot.clientCount).toBe(4);
      expect(snapshot.namespaces.find(entry => entry.namespace === 'consumer')?.peers).toEqual(replicas);
      expect(await findTopic()).toMatchObject({
        publishers: [{ host: '127.0.0.1', port: publisher.port }],
        subscribers: replicas,
        subscriberCount: 2,
      });
      expect(JSON.stringify(snapshot)).not.toContain('private-value');
      await expect(observer.listRegistryTopicSnapshots('variables.')).resolves.toEqual([
        expect.objectContaining({ subscribers: replicas, payload: { password: 'private-value' } }),
      ]);

      await unsubscribeFirst();
      expect((await findTopic())?.subscribers).toEqual([{ host: '127.0.0.1', port: second.port }]);
      const oldPort = second.port;
      await stops[2]();
      await vi.waitFor(async () => {
        expect((await findTopic())?.subscribers).toEqual([]);
        expect((await observer.getRegistrySnapshot()).clientCount).toBe(3);
      });
      await unsubscribeSecond();

      stops[2] = await second.listen(oldPort);
      await second.subscribe(topic, vi.fn());
      expect((await findTopic())?.subscribers).toEqual([{ host: '127.0.0.1', port: oldPort }]);
      const disconnected = once(registry.events, 'disconnect');
      registry.clients.get(`127.0.0.1:${oldPort}`)!.dispose();
      await disconnected;
      await vi.waitFor(async () => {
        expect((await findTopic())?.subscribers).toEqual([{ host: '127.0.0.1', port: oldPort }]);
        expect((await observer.getRegistrySnapshot()).clientCount).toBe(4);
      });
      await publication.unpublish();
      expect(await findTopic()).toMatchObject({ publishers: [], publisherCount: 0, hasData: false });

      const aborted = AbortSignal.abort(new Error('snapshot cancelled'));
      await expect(observer.getRegistrySnapshot({ signal: aborted })).rejects.toThrow();
      expect((await findTopic())?.subscriberCount).toBe(1);
    } finally {
      for (const stop of stops.reverse()) await stop();
      await stopRegistry();
    }
  });

  it('cancels in-flight snapshot reads and bounds them by the configured Registry timeout', async () => {
    const registry = new Registry(advertise);
    const registryPort = await getAvailablePort();
    const stopRegistry = await registry.listen(registryPort);
    const observer = new Application({
      namespace: 'cancellable-observer',
      registry: { host: '127.0.0.1', port: registryPort },
      registryLookupTimeoutMs: 1000,
      ...advertise,
    });
    let stopObserver: (() => Promise<void>) | undefined;
    const requests: AbortSignal[] = [];
    const originalDispatch = registry.dispatch.bind(registry);
    const dispatch = vi.spyOn(registry, 'dispatch').mockImplementation(async (path, data, extras, options) => {
      if (path !== '/-/registry/snapshot') return originalDispatch(path, data, extras, options);
      const signal = extras?.signal as AbortSignal;
      requests.push(signal);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    });

    try {
      stopObserver = await observer.listen(await getAvailablePort());
      const controller = new AbortController();
      const pending = observer.getRegistrySnapshot({ signal: controller.signal });
      const cancelled = expect(pending).rejects.toThrow('Abort');
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      controller.abort();
      await cancelled;
      await vi.waitFor(() => expect(requests[0].aborted).toBe(true));

      await expect(observer.getRegistrySnapshot()).rejects.toThrow(/timeout/i);
      await vi.waitFor(() => {
        expect(requests).toHaveLength(2);
        expect(requests[1].aborted).toBe(true);
      });
    } finally {
      dispatch.mockRestore();
      await stopObserver?.();
      await stopRegistry();
    }
  });

  it('fails explicitly when the Application has no Registry connection', async () => {
    const application = new Application({
      namespace: 'offline-observer',
      registry: { host: '127.0.0.1', port: 1 },
      ...advertise,
    });
    await expect(application.getRegistrySnapshot()).rejects.toThrow('Registry is not connected');
  });
});
