import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createExecutionContext } from '@hile/context';
import { Http } from '@hile/http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMcpGateway as createMcpGatewayRuntime, type CreateMcpGatewayOptions } from '../gateway/index.js';
import { InMemoryMcpProviderSource } from '../testing/index.js';
import type { McpProviderManifest } from '../micro/index.js';
import { createMcpProviderFingerprint } from '../micro/manifest.js';
import { createMcpHttpEndpoint } from './index.js';

const testExecutionContext = createExecutionContext({ requestId: 'mcp-http-test' });

function createMcpGateway(
  options: Omit<CreateMcpGatewayOptions, 'executionContext'> & Partial<Pick<CreateMcpGatewayOptions, 'executionContext'>>,
) {
  return createMcpGatewayRuntime({ executionContext: () => testExecutionContext, ...options });
}

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function listenOnEphemeralPort(http: Http) {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>(resolve => { resolvePort = resolve; });
  const stop = await http.listen(server => {
    server.once('listening', () => {
      const address = server.address();
      resolvePort(typeof address === 'object' && address ? address.port : 0);
    });
  });
  return { port: await port, stop };
}

describe('MCP Streamable HTTP endpoint', () => {
  const cleanup: Array<() => Promise<unknown>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it('rejects incomplete transport security options before constructing a handler', () => {
    expect(() => createMcpHttpEndpoint({} as any, {
      path: '/mcp',
      security: {
        allowedHostnames: ['localhost'],
        allowedOriginHostnames: ['client.example'],
      } as any,
    })).toThrow(/authentication mode/i);
    expect(() => createMcpHttpEndpoint({} as any, {
      path: '/mcp',
      security: {
        allowedHostnames: ['localhost'],
        allowedOriginHostnames: ['client.example'],
        authentication: { mode: 'required' } as any,
      },
    })).toThrow(/authentication mode/i);
  });

  it('snapshots the authentication mode instead of retaining mutable caller config', async () => {
    const source = new InMemoryMcpProviderSource();
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile-test', version: '1.0.0' },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const authenticate = vi.fn(async () => new Response('denied', { status: 401 }));
    const authentication = { mode: 'required' as const, authenticate };
    const endpoint = createMcpHttpEndpoint(gateway, {
      path: '/mcp',
      security: {
        allowedHostnames: ['127.0.0.1'],
        allowedOriginHostnames: ['client.example'],
        authentication,
      },
      legacy: 'reject',
    });
    (authentication as { mode: string }).mode = 'public';
    const http = new Http({ port: 0 });
    http.use(endpoint.middleware);
    const { port, stop } = await listenOnEphemeralPort(http);
    cleanup.push(async () => { await stop(); }, endpoint.close, () => gateway.close());

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { Origin: 'https://client.example' },
    });

    expect(response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
  });

  it('serves official OAuth metadata and bearer challenges', async () => {
    const port = await freePort();
    const source = new InMemoryMcpProviderSource();
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile-test', version: '1.0.0' },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const resourceServerUrl = new URL(`http://127.0.0.1:${port}/mcp`);
    const endpoint = createMcpHttpEndpoint(gateway, {
      path: '/mcp',
      security: {
        allowedHostnames: ['127.0.0.1'],
        allowedOriginHostnames: ['client.example'],
        authentication: {
          mode: 'oauth',
          verifier: { verifyAccessToken: async () => ({ token: 'valid', clientId: 'client', scopes: ['mcp:read'], expiresAt: Date.now() / 1_000 + 60 }) },
          requiredScopes: ['mcp:read'],
          metadata: {
            resourceServerUrl,
            oauthMetadata: {
              issuer: 'https://auth.example.com',
              authorization_endpoint: 'https://auth.example.com/authorize',
              token_endpoint: 'https://auth.example.com/token',
              response_types_supported: ['code'],
            },
          },
        },
      },
      legacy: 'reject',
    });
    const http = new Http({ port });
    http.use(endpoint.middleware);
    const stop = await http.listen();
    cleanup.push(async () => { await stop(); }, endpoint.close, () => gateway.close());

    const metadata = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-protected-resource/mcp`);
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource: resourceServerUrl.href,
      authorization_servers: ['https://auth.example.com'],
    });
    const challenge = await fetch(resourceServerUrl, {
      method: 'POST',
      headers: { Host: '127.0.0.1', Origin: 'https://client.example' },
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('serves a discovered tool through the official modern client', async () => {
    const identity = {
      providerId: 'orders',
      capabilities: {
        tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, execution: { retry: 'never' } }],
        resources: [], prompts: [],
      },
    };
    const manifest: McpProviderManifest = {
      protocol: 1, ...identity, instanceId: 'a', namespace: 'orders-service', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    };
    const source = new InMemoryMcpProviderSource([manifest], (_instance, _operation, data: any) => ({
      content: [{ type: 'text', text: data.input.id }],
    }));
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile-test', version: '1.0.0' },
      cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'public' } },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const endpoint = createMcpHttpEndpoint(gateway, {
      path: '/mcp',
      security: {
        allowedHostnames: ['127.0.0.1'],
        allowedOriginHostnames: ['client.example'],
        authentication: { mode: 'public' },
      },
      legacy: 'reject',
    });
    const http = new Http({ port: 0 });
    http.use(endpoint.middleware);
    const { port, stop } = await listenOnEphemeralPort(http);
    cleanup.push(async () => { await stop(); }, endpoint.close, () => gateway.close());

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Origin: 'https://client.example' } },
    });
    const client = new Client(
      { name: 'official-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(transport);
    cleanup.push(() => client.close());

    expect(await client.listTools()).toMatchObject({
      tools: [expect.objectContaining({ name: 'orders.lookup' })],
      ttlMs: 60_000,
      cacheScope: 'public',
    });
    expect(await client.callTool({ name: 'orders.lookup', arguments: { id: '42' } })).toEqual(expect.objectContaining({
      content: [{ type: 'text', text: '42' }],
    }));
  });

  it('publishes catalog changes to modern HTTP subscriptions', async () => {
    const source = new InMemoryMcpProviderSource();
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile-test', version: '1.0.0' },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const endpoint = createMcpHttpEndpoint(gateway, {
      path: '/mcp',
      security: {
        allowedHostnames: ['127.0.0.1'],
        allowedOriginHostnames: ['client.example'],
        authentication: { mode: 'public' },
      },
      legacy: 'reject',
    });
    const http = new Http({ port: 0 });
    http.use(endpoint.middleware);
    const { port, stop } = await listenOnEphemeralPort(http);
    cleanup.push(async () => { await stop(); }, endpoint.close, () => gateway.close());

    let resolveChanged!: (tools: string[]) => void;
    const changed = new Promise<string[]>(resolve => { resolveChanged = resolve; });
    const client = new Client(
      { name: 'official-test-client', version: '1.0.0' },
      {
        versionNegotiation: { mode: { pin: '2026-07-28' } },
        listChanged: {
          tools: {
            onChanged(error, tools) {
              if (error) throw error;
              resolveChanged(tools.map(tool => tool.name));
            },
          },
        },
      },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Origin: 'https://client.example' } },
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    expect(client.autoOpenedSubscription).toBeDefined();

    const identity = {
      providerId: 'orders',
      capabilities: {
        tools: [{ name: 'lookup', inputSchema: { type: 'object' }, execution: { retry: 'never' as const } }],
        resources: [], prompts: [],
      },
    };
    source.setInstances([{
      protocol: 1,
      ...identity,
      instanceId: 'a',
      namespace: 'orders-service',
      address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    }]);

    await expect(Promise.race([
      changed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('list_changed timeout')), 500)),
    ])).resolves.toEqual(['orders.lookup']);
  });

  it('publishes resource updates to modern HTTP subscriptions', async () => {
    const identity = {
      providerId: 'docs',
      capabilities: { tools: [], resources: [{ name: 'manual', uri: 'hile://docs/manual' }], prompts: [] },
    };
    const manifest: McpProviderManifest = {
      protocol: 1, ...identity, instanceId: 'a', namespace: 'docs', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    };
    const source = new InMemoryMcpProviderSource([manifest]);
    const gateway = await createMcpGateway({
      source,
      info: { name: 'hile-test', version: '1.0.0' },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const endpoint = createMcpHttpEndpoint(gateway, {
      path: '/mcp',
      security: {
        allowedHostnames: ['127.0.0.1'],
        allowedOriginHostnames: ['client.example'],
        authentication: { mode: 'public' },
      },
      legacy: 'reject',
    });
    const http = new Http({ port: 0 });
    http.use(endpoint.middleware);
    const { port, stop } = await listenOnEphemeralPort(http);
    cleanup.push(async () => { await stop(); }, endpoint.close, () => gateway.close());

    const client = new Client(
      { name: 'official-test-client', version: '1.0.0' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Origin: 'https://client.example' } },
    });
    await client.connect(transport);
    cleanup.push(() => client.close());
    let resolveUpdated!: (uri: string) => void;
    const updated = new Promise<string>(resolve => { resolveUpdated = resolve; });
    client.setNotificationHandler('notifications/resources/updated', notification => resolveUpdated(notification.params.uri));
    const subscription = await client.listen({ resourceSubscriptions: ['hile://docs/manual'] });
    cleanup.push(() => subscription.close());

    source.emitResourceUpdated({ eventId: 'event-1', providerId: 'docs', instanceId: 'a', fingerprint: manifest.fingerprint, uri: 'hile://docs/manual' });

    await expect(Promise.race([
      updated,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('resource update timeout')), 500)),
    ])).resolves.toBe('hile://docs/manual');
  });
});
