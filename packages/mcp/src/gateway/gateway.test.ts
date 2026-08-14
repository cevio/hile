import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createMcpGateway, mcpServerFactory } from './gateway.js';
import type { McpProviderManifest, McpProviderSource } from '../micro/index.js';
import { createMcpProviderFingerprint } from '../micro/manifest.js';

const trustedInvocation = { mode: 'trusted-internal' as const };

function provider(instanceId: string, version = 'v1', providerId = 'orders'): McpProviderManifest {
  const identity = {
    providerId,
    capabilities: {
      tools: [{ name: 'lookup', description: version, inputSchema: { type: 'object' }, execution: { retry: 'never' as const } }],
      resources: [{ name: 'manual', uri: `hile://${providerId}/manual` }],
      prompts: [],
    },
  };
  return {
    protocol: 1, ...identity, instanceId, namespace: `${providerId}-service`,
    address: { host: '127.0.0.1', port: 4100 + instanceId.length },
    fingerprint: createMcpProviderFingerprint(identity),
  };
}

class Source implements McpProviderSource {
  items: McpProviderManifest[] = [];
  listeners = new Set<(items: readonly McpProviderManifest[]) => void>();
  start = vi.fn(async () => undefined);
  snapshot = () => this.items;
  subscribe = (listener: (items: readonly McpProviderManifest[]) => void) => (this.listeners.add(listener), () => this.listeners.delete(listener));
  async stream(): Promise<AsyncIterable<unknown>> { return (async function* () { yield { type: 'result', result: { content: [] } }; })(); }
  close = vi.fn(async () => undefined);
  set(items: McpProviderManifest[]) { this.items = items; for (const listener of this.listeners) listener(items); }
}

describe('MCP gateway catalog', () => {
  it('rejects invalid public naming options at startup', async () => {
    const source = new Source();
    await expect(createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      naming: { separator: '/' as any },
      invocationSecurity: trustedInvocation,
    })).rejects.toThrow(/separator/i);
    expect(source.start).not.toHaveBeenCalled();
  });

  it('groups compatible instances and exposes deterministic qualified names', async () => {
    const source = new Source();
    source.items = [provider('b'), provider('a')];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });

    expect(gateway.inspect()).toEqual(expect.objectContaining({
      providers: [expect.objectContaining({ providerId: 'orders', status: 'ready', instanceCount: 2 })],
      tools: ['orders.lookup'],
    }));
    await gateway.close();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('fails closed when instances of one provider publish different fingerprints', async () => {
    const source = new Source();
    source.items = [provider('a', 'v1'), provider('b', 'v2')];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });

    expect(gateway.inspect().providers[0]).toEqual(expect.objectContaining({ status: 'conflict', instanceCount: 2 }));
    expect(gateway.inspect().tools).toEqual([]);
    await gateway.close();
  });

  it('fails closed on public-name collisions introduced by aliases', async () => {
    const source = new Source();
    const payments = provider('payments-a', 'v1', 'payments');
    source.items = [provider('orders-a'), payments];
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      naming: { aliases: { orders: 'commerce', payments: 'commerce' } },
      invocationSecurity: trustedInvocation,
    });

    expect(gateway.inspect().tools).toEqual([]);
    expect(gateway.inspect().providers.every(item => item.status === 'conflict')).toBe(true);
    await gateway.close();
  });

  it('does not read inherited alias properties', async () => {
    const source = new Source();
    source.items = [provider('a', 'v1', 'toString')];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, naming: { aliases: {} }, invocationSecurity: trustedInvocation });
    expect(gateway.inspect().tools).toEqual(['toString.lookup']);
    await gateway.close();
  });

  it('closes the source when require-provider startup fails', async () => {
    const source = new Source();
    await expect(createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      startup: 'require-provider',
      invocationSecurity: trustedInvocation,
    })).rejects.toThrow(/at least one provider/i);
    expect(source.close).toHaveBeenCalledOnce();
  });

  it('fails an idempotent invocation over after a peer stream terminates before its result', async () => {
    const first = provider('a');
    const identity = {
      providerId: first.providerId,
      capabilities: {
        ...first.capabilities,
        tools: [{ ...first.capabilities.tools[0], annotations: { readOnlyHint: true, idempotentHint: true }, execution: { retry: 'idempotent-failover' as const } }],
      },
    };
    const instances = ['a', 'b'].map(instanceId => ({
      ...first,
      ...identity,
      instanceId,
      address: { host: '127.0.0.1', port: instanceId === 'a' ? 4101 : 4102 },
      fingerprint: createMcpProviderFingerprint(identity),
    }));
    const source = new Source();
    source.items = instances;
    source.stream = vi.fn(async (instance: McpProviderManifest) => instance.instanceId === 'a'
      ? (async function* () { throw new Error('peer disconnected'); })()
      : (async function* () { yield { type: 'result', result: { content: [{ type: 'text', text: 'ok' }] } }; })());
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(client.callTool({ name: 'orders.lookup', arguments: {} })).resolves.toEqual(expect.objectContaining({
      content: [{ type: 'text', text: 'ok' }],
    }));
    expect(source.stream).toHaveBeenCalledTimes(2);
    await client.close();
    await server.close();
    await gateway.close();
  });

  it('rejects calls from an already-created server after gateway close', async () => {
    const source = new Source();
    source.items = [provider('a')];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await gateway.close();
    await expect(client.callTool({ name: 'orders.lookup', arguments: {} })).resolves.toEqual(expect.objectContaining({
      isError: true,
      content: [expect.objectContaining({ type: 'text', text: expect.stringMatching(/closed/i) })],
    }));
    await client.close();
    await server.close();
  });

  it('updates the catalog of an already-connected server', async () => {
    const source = new Source();
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    expect((await client.listTools()).tools).toEqual([]);

    source.set([provider('a')]);
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['orders.lookup']);
    source.set([]);
    expect((await client.listTools()).tools).toEqual([]);

    await client.close();
    await server.close();
    await gateway.close();
  });
});
