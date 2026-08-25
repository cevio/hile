import { Client } from '@modelcontextprotocol/client';
import { createExecutionContext } from '@hile/context';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { createMcpGateway } from '../gateway/index.js';
import { createMcpProviderFingerprint } from '../micro/manifest.js';
import type { McpProviderManifest } from '../micro/index.js';
import { InMemoryMcpProviderSource } from '../testing/index.js';
import { serveMcpStdio } from './index.js';

describe('MCP stdio adapter', () => {
  it('injects an explicit process identity for scoped capabilities', async () => {
    const identity = { providerId: 'orders', capabilities: {
      tools: [{ name: 'lookup', inputSchema: { type: 'object' }, scopes: ['orders:read'], execution: { retry: 'never' as const } }],
      resources: [], prompts: [],
    } };
    const manifest: McpProviderManifest = {
      protocol: 1, ...identity, instanceId: 'a', namespace: 'orders', address: { host: '127.0.0.1', port: 4100 },
      fingerprint: createMcpProviderFingerprint(identity),
    };
    const gateway = await createMcpGateway({
      source: new InMemoryMcpProviderSource([manifest]),
      executionContext: () => createExecutionContext({ requestId: 'mcp-stdio-test' }),
      info: { name: 'stdio-test', version: '1.0.0' },
      invocationSecurity: { mode: 'trusted-internal' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveMcpStdio(gateway, {
      transport: serverTransport,
      authInfo: { token: 'process', clientId: 'cli', scopes: ['orders:read'] },
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['orders.lookup']);
    await client.close();
    await handle.close();
    await gateway.close();
  });
});
