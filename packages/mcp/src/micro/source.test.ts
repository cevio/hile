import { describe, expect, it, vi } from 'vitest';
import { createHileMcpProviderSource } from './source.js';
import { createMcpProviderFingerprint } from './manifest.js';
import type { McpProviderManifest } from './types.js';

const manifest = (instanceId: string): McpProviderManifest => {
  const identity = { providerId: 'orders', capabilities: { tools: [], resources: [], prompts: [] } };
  return {
    protocol: 1,
    ...identity,
    instanceId,
    namespace: 'orders-service',
    address: { host: '127.0.0.1', port: instanceId === 'a' ? 4101 : 4102 },
    fingerprint: createMcpProviderFingerprint(identity),
  };
};

const subscribedApplication = <T extends object>(application: T) => ({
  subscribe: vi.fn(async () => vi.fn(async () => undefined)),
  ...application,
});

describe('Hile MCP provider source', () => {
  it('discovers every retained instance topic and removes disappeared instances', async () => {
    let topics = ['@hile/mcp/providers/orders/a', '@hile/mcp/providers/orders/b'];
    const payloads = new Map(topics.map((topic, index) => [topic, manifest(index ? 'b' : 'a')]));
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => topics.map(topic => {
        const payload = payloads.get(topic)!;
        return { topic, payload, publishers: [payload.address] };
      })),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    expect(application.listRegistryTopicSnapshots).toHaveBeenCalledTimes(1);
    expect(source.snapshot().map(item => item.instanceId)).toEqual(['a', 'b']);
    topics = [topics[1]];
    await source.refresh();
    expect(source.snapshot().map(item => item.instanceId)).toEqual(['b']);
    await source.close();
  });

  it('reuses an unchanged validated manifest across discovery polls', async () => {
    const item = manifest('a');
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic: '@hile/mcp/providers/orders/a',
        payload: structuredClone(item),
        publishers: [item.address],
      }]),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    const initial = source.snapshot()[0];
    await source.refresh();
    await source.refresh();

    expect(source.snapshot()[0]).toBe(initial);
    await source.close();
  });

  it('revalidates a changed payload even when its provider identity is unchanged', async () => {
    const item = manifest('a');
    let payload: unknown = structuredClone(item);
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic: '@hile/mcp/providers/orders/a',
        payload,
        publishers: [item.address],
      }]),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    payload = {
      ...item,
      capabilities: { ...item.capabilities, tools: [{ name: 'invalid' }] },
    };
    await source.refresh();

    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('rechecks topic and publisher ownership when a cached payload is unchanged', async () => {
    const item = manifest('a');
    let topic = '@hile/mcp/providers/orders/a';
    let publishers = [item.address];
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic,
        payload: structuredClone(item),
        publishers,
      }]),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    publishers = [{ ...item.address, port: item.address.port + 1 }];
    await source.refresh();
    expect(source.snapshot()).toEqual([]);

    publishers = [item.address];
    await source.refresh();
    expect(source.snapshot()).toHaveLength(1);

    topic = '@hile/mcp/providers/orders/spoofed';
    await source.refresh();
    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('rejects a manifest whose address differs from its Registry publisher', async () => {
    const item = manifest('a');
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic: '@hile/mcp/providers/orders/a',
        payload: item,
        publishers: [{ host: '127.0.0.1', port: 9999 }],
      }]),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    await source.start();
    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('aborts an in-flight discovery read during close without failing teardown', async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn((_prefix, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        started();
        options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Abort'), { status: 'ECONNABORTED' })), { once: true });
      })),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const starting = source.start();
    await reading;
    await expect(source.close()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ status: 'ECONNABORTED' });
  });

  it('serializes concurrent starts into one resource-update subscription', async () => {
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await Promise.all([source.start(), source.start()]);

    expect(application.subscribe).toHaveBeenCalledOnce();
    await source.close();
  });

  it('waits for and releases a subscription that resolves during close', async () => {
    let resolveSubscribe!: (unsubscribe: () => Promise<void>) => void;
    const unsubscribe = vi.fn(async () => undefined);
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
      subscribe: vi.fn(() => new Promise<() => Promise<void>>(resolve => { resolveSubscribe = resolve; })),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const starting = source.start();
    const closing = source.close();

    resolveSubscribe(unsubscribe);

    await expect(closing).resolves.toBeUndefined();
    await expect(starting).rejects.toThrow(/closed/i);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('retries resource-update unsubscription after a teardown failure', async () => {
    const unsubscribe = vi.fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce(undefined);
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
      subscribe: vi.fn(async () => unsubscribe),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    await source.start();

    await expect(source.close()).rejects.toThrow(/registry unavailable/i);
    await expect(source.close()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('retains a late subscription cleanup handle when close must retry it', async () => {
    let resolveSubscribe!: (unsubscribe: () => Promise<void>) => void;
    const unsubscribe = vi.fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce(undefined);
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
      subscribe: vi.fn(() => new Promise<() => Promise<void>>(resolve => { resolveSubscribe = resolve; })),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const starting = source.start();
    const closing = source.close();

    resolveSubscribe(unsubscribe);

    await expect(starting).rejects.toThrow(/closed/i);
    await expect(closing).rejects.toThrow(/registry unavailable/i);
    await expect(source.close()).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('isolates listener failures and still notifies later subscribers', async () => {
    let snapshots: any[] = [];
    const errors: unknown[] = [];
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [] as Array<{ topic: string; payload: unknown; publishers: Array<{ host: string; port: number }> }>),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000, onError: error => errors.push(error) });
    await source.start();
    source.subscribe(() => { throw new Error('listener failed'); });
    source.subscribe(snapshot => { snapshots = [...snapshot]; });
    const item = manifest('a');
    application.listRegistryTopicSnapshots.mockResolvedValueOnce([{
      topic: '@hile/mcp/providers/orders/a', payload: item, publishers: [item.address],
    }]);

    await expect(source.refresh()).resolves.toBeUndefined();
    expect(snapshots.map(item => item.instanceId)).toEqual(['a']);
    expect(errors).toHaveLength(1);
    await source.close();
  });

  it('rejects malformed or topic-spoofed retained manifests', async () => {
    const topic = '@hile/mcp/providers/orders/a';
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => [{ topic, payload: { ...manifest('a'), providerId: 'payments' }, publishers: [manifest('a').address] }]),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('targets the exact discovered provider instance when streaming', async () => {
    const stream = (async function* () {})();
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(async () => stream),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const instance = manifest('a');

    await expect(source.stream(instance, '/-/mcp/invoke', {}, { timeout: 500 })).resolves.toBe(stream);
    expect(application.streamPeer).toHaveBeenCalledWith(
      instance.address,
      '/-/mcp/invoke',
      {},
      { timeout: 500 },
    );
    await source.close();
  });

  it('validates and deduplicates resource update events from the shared topic', async () => {
    const item = manifest('a');
    let receive!: (payload: unknown) => void;
    const unsubscribe = vi.fn(async () => undefined);
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic: '@hile/mcp/providers/orders/a', payload: item, publishers: [item.address],
      }]),
      streamPeer: vi.fn(),
      subscribe: vi.fn(async (_topic: string, listener: (payload: unknown) => void) => {
        receive = listener;
        return unsubscribe;
      }),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const updates: unknown[] = [];
    source.subscribeResourceUpdates(update => updates.push(update));
    await source.start();

    const update = {
      eventId: 'event-1', providerId: 'orders', instanceId: 'a', fingerprint: item.fingerprint, uri: 'hile://orders/manual',
    };
    receive(update);
    receive(update);
    receive({ ...update, eventId: 'event-2', fingerprint: 'spoofed' });

    expect(application.subscribe).toHaveBeenCalledWith('@hile/mcp/resource-updates', expect.any(Function));
    expect(updates).toEqual([update]);
    await source.close();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('accepts resource updates from every compatible discovered replica', async () => {
    let receive!: (payload: unknown) => void;
    const first = manifest('replica-a');
    const second = { ...manifest('replica-b'), fingerprint: first.fingerprint };
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => [first, second].map(item => ({
        topic: `@hile/mcp/providers/${item.providerId}/${item.instanceId}`,
        payload: item,
        publishers: [item.address],
      }))),
      streamPeer: vi.fn(),
      subscribe: vi.fn(async (_topic: string, listener: (payload: unknown) => void) => {
        receive = listener;
        return vi.fn(async () => undefined);
      }),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 1_000 });
    const updates: unknown[] = [];
    source.subscribeResourceUpdates(update => updates.push(update));
    await source.start();

    receive({
      eventId: 'replica-b-update',
      providerId: second.providerId,
      instanceId: second.instanceId,
      fingerprint: second.fingerprint,
      uri: 'hile://orders/manual',
    });

    expect(updates).toEqual([expect.objectContaining({ instanceId: 'replica-b', uri: 'hile://orders/manual' })]);
    await source.close();
  });

  it('does not retain subscriptions after close', async () => {
    const application = subscribedApplication({
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
    });
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    await source.close();

    expect(() => source.subscribe(vi.fn())).toThrow(/closed/i);
  });
});
