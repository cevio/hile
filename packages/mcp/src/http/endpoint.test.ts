import { createServer } from 'node:net';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Http } from '@hile/http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpGateway } from '../gateway/index.js';
import { InMemoryMcpProviderSource } from '../testing/index.js';
import type { McpProviderManifest } from '../micro/index.js';
import { createMcpProviderFingerprint } from '../micro/manifest.js';
import { createMcpHttpEndpoint } from './index.js';

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
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
    const port = await freePort();
    const http = new Http({ port });
    http.use(endpoint.middleware);
    const stop = await http.listen();
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

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['orders.lookup']);
    expect(await client.callTool({ name: 'orders.lookup', arguments: { id: '42' } })).toEqual(expect.objectContaining({
      content: [{ type: 'text', text: '42' }],
    }));
  });
});
