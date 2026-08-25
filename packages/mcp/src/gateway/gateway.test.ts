import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext } from '@hile/context';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import {
  createMcpGateway as createMcpGatewayRuntime,
  mcpServerFactory,
  type CreateMcpGatewayOptions,
} from './gateway.js';
import type { McpProviderManifest, McpProviderSource } from '../micro/index.js';
import { createMcpProviderFingerprint } from '../micro/manifest.js';

const trustedInvocation = { mode: 'trusted-internal' as const };
const testExecutionContext = createExecutionContext({ requestId: 'mcp-gateway-test' });

function createMcpGateway(
  options: Omit<CreateMcpGatewayOptions, 'executionContext'> & Partial<Pick<CreateMcpGatewayOptions, 'executionContext'>>,
) {
  return createMcpGatewayRuntime({ executionContext: () => testExecutionContext, ...options });
}

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
  resourceListeners = new Set<(update: any) => void>();
  start = vi.fn(async () => undefined);
  snapshot = () => this.items;
  subscribe = (listener: (items: readonly McpProviderManifest[]) => void) => (this.listeners.add(listener), () => this.listeners.delete(listener));
  subscribeResourceUpdates = (listener: (update: any) => void) => (this.resourceListeners.add(listener), () => this.resourceListeners.delete(listener));
  async stream(): Promise<AsyncIterable<unknown>> { return (async function* () { yield { type: 'result', result: { content: [] } }; })(); }
  close = vi.fn(async () => undefined);
  set(items: McpProviderManifest[]) { this.items = items; for (const listener of this.listeners) listener(items); }
  emitResourceUpdated(update: any) { for (const listener of this.resourceListeners) listener(update); }
}

describe('MCP gateway catalog', () => {
  it('requires an explicit ingress execution-context resolver', async () => {
    const source = new Source();
    await expect(createMcpGatewayRuntime({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: trustedInvocation,
    } as CreateMcpGatewayOptions)).rejects.toThrow(/executionContext/i);
    expect(source.start).not.toHaveBeenCalled();
  });

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

  it('treats an explicit wildcard grant as access to every discovered scope', async () => {
    const source = new Source();
    const base = provider('a');
    const identity = {
      providerId: base.providerId,
      capabilities: {
        ...base.capabilities,
        tools: [{ ...base.capabilities.tools[0], scopes: ['orders:read'] }],
      },
    };
    source.items = [{ ...base, ...identity, fingerprint: createMcpProviderFingerprint(identity) }];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const server = mcpServerFactory(gateway)({
      authInfo: { token: 'operator', clientId: 'operator', scopes: ['*'] },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['orders.lookup']);

    await client.close();
    await server.close();
    await gateway.close();
  });

  it('round-robins compatible instances while preserving the selected instance identity', async () => {
    const source = new Source();
    source.items = [provider('a'), provider('b')];
    const ingressContext = createExecutionContext({ requestId: 'request-a', values: { tenantId: 'tenant-a' } });
    source.stream = vi.fn(async (instance: McpProviderManifest, _operation, request: any, options: any) => (async function* () {
      expect(request).toMatchObject({
        providerId: instance.providerId,
        instanceId: instance.instanceId,
        fingerprint: instance.fingerprint,
      });
      expect(options.context).toEqual(ingressContext);
      expect(Object.isFrozen(options.context)).toBe(true);
      yield { type: 'result', result: { content: [{ type: 'text', text: instance.instanceId }] } };
    })());
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: trustedInvocation,
      executionContext: () => ingressContext,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const results = await Promise.all([
      client.callTool({ name: 'orders.lookup', arguments: {} }),
      client.callTool({ name: 'orders.lookup', arguments: {} }),
    ]);

    expect(results.map(result => result.content[0])).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    await client.close();
    await server.close();
    await gateway.close();
  });

  it('projects official capability metadata through the SDK', async () => {
    const icon = { src: 'https://example.com/icon.svg', theme: 'dark' as const };
    const identity = {
      providerId: 'catalog',
      capabilities: {
        tools: [{ name: 'lookup', inputSchema: { type: 'object' }, icons: [icon], _meta: { 'io.example/tool': true }, execution: { retry: 'never' as const } }],
        resources: [{
          name: 'manual', uri: 'hile://catalog/manual', icons: [icon], size: 42,
          annotations: { audience: ['assistant' as const], priority: 0.8 }, _meta: { 'io.example/resource': true },
          cacheHint: { ttlMs: 60_000, cacheScope: 'public' as const },
        }],
        prompts: [{ name: 'summarize', inputSchema: { type: 'object' }, icons: [icon], _meta: { 'io.example/prompt': true } }],
      },
    };
    const source = new Source();
    source.items = [{
      protocol: 1, ...identity, instanceId: 'a', namespace: 'catalog', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    }];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools[0]).toMatchObject({ icons: [icon], _meta: { 'io.example/tool': true } });
    expect((await client.listResources()).resources[0]).toMatchObject({
      icons: [icon], size: 42, annotations: { audience: ['assistant'], priority: 0.8 }, _meta: { 'io.example/resource': true },
    });
    expect((await client.listPrompts()).prompts[0]).toMatchObject({ icons: [icon], _meta: { 'io.example/prompt': true } });

    await client.close();
    await server.close();
    await gateway.close();
  });

  it('routes prompt completions through the official completion API', async () => {
    const identity = {
      providerId: 'catalog',
      capabilities: {
        tools: [], resources: [],
        prompts: [{
          name: 'review',
          inputSchema: {
            type: 'object',
            properties: { language: { type: 'string' } },
            required: ['language'],
          },
          completionArguments: ['language'],
        }],
      },
    };
    const source = new Source();
    source.items = [{
      protocol: 1, ...identity, instanceId: 'a', namespace: 'catalog', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity as any),
    }] as any;
    source.stream = vi.fn(async (_instance, operation, data: any) => (async function* () {
      expect(operation).toBe('/-/mcp/complete');
      expect(data.input).toEqual({ argument: 'language', value: 'ty', context: undefined });
      yield { type: 'result', result: ['typescript'] };
    })());
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(client.complete({
      ref: { type: 'ref/prompt', name: 'catalog.review' },
      argument: { name: 'language', value: 'ty' },
    })).resolves.toEqual({ completion: { values: ['typescript'], total: 1, hasMore: false } });

    await client.close();
    await server.close();
    await gateway.close();
  });

  it('routes resource template completions through the official completion API', async () => {
    const identity = {
      providerId: 'catalog',
      capabilities: {
        tools: [], prompts: [],
        resources: [{ name: 'manual', uriTemplate: 'hile://catalog/{language}', completionArguments: ['language'] }],
      },
    };
    const source = new Source();
    source.items = [{
      protocol: 1, ...identity, instanceId: 'a', namespace: 'catalog', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    }];
    source.stream = vi.fn(async () => (async function* () {
      yield { type: 'result', result: ['typescript'] };
    })());
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({});
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(client.complete({
      ref: { type: 'ref/resource', uri: 'hile://catalog/{language}' },
      argument: { name: 'language', value: 'ty' },
    })).resolves.toEqual({ completion: { values: ['typescript'], total: 1, hasMore: false } });

    await client.close();
    await server.close();
    await gateway.close();
  });

  it('snapshots credential invocation security instead of retaining mutable caller config', async () => {
    const source = new Source();
    source.items = [provider('a')];
    const create = vi.fn(async () => ({ signed: true }));
    const invocationSecurity: { mode: 'credential' | 'trusted-internal'; credentials: { create: typeof create } } = {
      mode: 'credential', credentials: { create },
    };
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: invocationSecurity as { mode: 'credential'; credentials: { create: typeof create } },
    });
    invocationSecurity.mode = 'trusted-internal';
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({ era: 'legacy' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({ name: 'orders.lookup', arguments: {} });

    expect(create).toHaveBeenCalledOnce();
    await client.close();
    await server.close();
    await gateway.close();
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

  it('does not rebuild a live catalog when only compatible instances change', async () => {
    const source = new Source();
    source.items = [provider('a')];
    const gateway = await createMcpGateway({ source, info: { name: 'hile', version: '1.0.0' }, invocationSecurity: trustedInvocation });
    const server = mcpServerFactory(gateway)({ era: 'legacy' });
    const registerTool = vi.spyOn(server, 'registerTool');

    source.set([provider('a'), provider('b')]);

    expect(registerTool).not.toHaveBeenCalled();
    expect(gateway.inspect().providers[0]).toMatchObject({ status: 'ready', instanceCount: 2 });
    await server.close();
    await gateway.close();
  });

  it('removes an HTTP-style projection when the low-level server closes', async () => {
    const source = new Source();
    const item = provider('a');
    source.items = [item];
    const errors: unknown[] = [];
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: trustedInvocation,
      onError: error => errors.push(error),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({ era: 'modern' });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await server.server.close();

    source.emitResourceUpdated({
      eventId: 'event-1', providerId: 'orders', instanceId: 'a', fingerprint: item.fingerprint, uri: 'hile://orders/manual',
    });
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(errors).toEqual([]);
    await client.close();
    await gateway.close();
  });

  it('delivers legacy resource updates only after that connection subscribes', async () => {
    const source = new Source();
    const item = provider('a');
    source.items = [item];
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: trustedInvocation,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({ era: 'legacy' });
    const client = new Client({ name: 'legacy-test', version: '1.0.0' });
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', notification => {
      updates.push(notification.params.uri);
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const update = {
      eventId: 'event-legacy', providerId: 'orders', instanceId: 'a', fingerprint: item.fingerprint, uri: 'hile://orders/manual',
    };
    source.emitResourceUpdated(update);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(updates).toEqual([]);

    await client.subscribeResource({ uri: update.uri });
    source.emitResourceUpdated({ ...update, eventId: 'event-subscribed' });
    await vi.waitFor(() => expect(updates).toEqual([update.uri]));

    await client.unsubscribeResource({ uri: update.uri });
    source.emitResourceUpdated({ ...update, eventId: 'event-unsubscribed' });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(updates).toEqual([update.uri]);

    await client.close();
    await server.close();
    await gateway.close();
  });

  it('does not push resource updates directly through an HTTP request server', async () => {
    const source = new Source();
    const item = provider('a');
    source.items = [item];
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile', version: '1.0.0' },
      invocationSecurity: trustedInvocation,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = mcpServerFactory(gateway)({ era: 'modern', requestInfo: new Request('http://localhost/mcp') });
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    const updates: string[] = [];
    client.setNotificationHandler('notifications/resources/updated', notification => {
      updates.push(notification.params.uri);
    });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    source.emitResourceUpdated({
      eventId: 'event-http', providerId: 'orders', instanceId: 'a', fingerprint: item.fingerprint, uri: 'hile://orders/manual',
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(updates).toEqual([]);

    await client.close();
    await server.close();
    await gateway.close();
  });
});
