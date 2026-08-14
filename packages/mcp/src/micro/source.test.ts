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

describe('Hile MCP provider source', () => {
  it('discovers every retained instance topic and removes disappeared instances', async () => {
    let topics = ['@hile/mcp/providers/orders/a', '@hile/mcp/providers/orders/b'];
    const payloads = new Map(topics.map((topic, index) => [topic, manifest(index ? 'b' : 'a')]));
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => topics.map(topic => {
        const payload = payloads.get(topic)!;
        return { topic, payload, publishers: [payload.address] };
      })),
      streamPeer: vi.fn(),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    expect(application.listRegistryTopicSnapshots).toHaveBeenCalledTimes(1);
    expect(source.snapshot().map(item => item.instanceId)).toEqual(['a', 'b']);
    topics = [topics[1]];
    await source.refresh();
    expect(source.snapshot().map(item => item.instanceId)).toEqual(['b']);
    await source.close();
  });

  it('rejects a manifest whose address differs from its Registry publisher', async () => {
    const item = manifest('a');
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => [{
        topic: '@hile/mcp/providers/orders/a',
        payload: item,
        publishers: [{ host: '127.0.0.1', port: 9999 }],
      }]),
      streamPeer: vi.fn(),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    await source.start();
    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('aborts an in-flight discovery read during close without failing teardown', async () => {
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const application = {
      listRegistryTopicSnapshots: vi.fn((_prefix, options?: { signal?: AbortSignal }) => new Promise<never>((_resolve, reject) => {
        started();
        options?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Abort'), { status: 'ECONNABORTED' })), { once: true });
      })),
      streamPeer: vi.fn(),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    const starting = source.start();
    await reading;
    await expect(source.close()).resolves.toBeUndefined();
    await expect(starting).rejects.toMatchObject({ status: 'ECONNABORTED' });
  });

  it('isolates listener failures and still notifies later subscribers', async () => {
    let snapshots: any[] = [];
    const errors: unknown[] = [];
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => [] as Array<{ topic: string; payload: unknown; publishers: Array<{ host: string; port: number }> }>),
      streamPeer: vi.fn(),
    };
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
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => [{ topic, payload: { ...manifest('a'), providerId: 'payments' }, publishers: [manifest('a').address] }]),
      streamPeer: vi.fn(),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });

    await source.start();
    expect(source.snapshot()).toEqual([]);
    await source.close();
  });

  it('targets the exact discovered provider instance when streaming', async () => {
    const stream = (async function* () {})();
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(async () => stream),
    };
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

  it('does not retain subscriptions after close', async () => {
    const application = {
      listRegistryTopicSnapshots: vi.fn(async () => []),
      streamPeer: vi.fn(),
    };
    const source = createHileMcpProviderSource(application, { pollIntervalMs: 60_000 });
    await source.close();

    expect(() => source.subscribe(vi.fn())).toThrow(/closed/i);
  });
});
