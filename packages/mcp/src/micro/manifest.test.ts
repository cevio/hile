import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineMcpPrompt, defineMcpProvider, defineMcpResource, defineMcpTool } from '../definitions.js';
import { createMcpProviderFingerprint, createMcpProviderManifest, parseMcpProviderManifest } from './manifest.js';

describe('MCP provider manifests', () => {
  it('uses locale-independent canonical key ordering', () => {
    const left = { providerId: 'docs', capabilities: { tools: [{ name: 'lookup', inputSchema: { type: 'object', properties: { 'ä': {}, z: {} } }, execution: { retry: 'never' as const } }], resources: [], prompts: [] } };
    const right = { providerId: 'docs', capabilities: { tools: [{ name: 'lookup', inputSchema: { properties: { z: {}, 'ä': {} }, type: 'object' }, execution: { retry: 'never' as const } }], resources: [], prompts: [] } };
    expect(createMcpProviderFingerprint(left)).toBe(createMcpProviderFingerprint(right));
  });

  it('rejects duplicate resource identities within one provider', () => {
    const identity = { providerId: 'docs', capabilities: { tools: [], resources: [
      { name: 'manual-a', uri: 'hile://docs/manual' },
      { name: 'manual-b', uri: 'hile://docs/manual' },
    ], prompts: [] } };
    const manifest = { protocol: 1, ...identity, instanceId: 'a', namespace: 'docs', address: { host: '127.0.0.1', port: 4100 }, fingerprint: createMcpProviderFingerprint(identity) };
    expect(parseMcpProviderManifest(manifest)).toBeUndefined();
  });

  it.each([
    { inputSchema: { type: 'garbage' }, execution: { retry: 'never' } },
    { inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'yes' }, execution: { retry: 'never' } },
    { inputSchema: { type: 'object' }, annotations: {}, execution: { retry: 'idempotent-failover' } },
  ])('rejects unsafe tool metadata %#', tool => {
    const identity = { providerId: 'unsafe', capabilities: { tools: [{ name: 'lookup', ...tool }], resources: [], prompts: [] } };
    const manifest = { protocol: 1, ...identity, instanceId: 'a', namespace: 'unsafe', address: { host: '127.0.0.1', port: 4100 }, fingerprint: createMcpProviderFingerprint(identity as any) };
    expect(parseMcpProviderManifest(manifest)).toBeUndefined();
  });

  it('publishes official metadata and resource cache hints', () => {
    const metadata = {
      icons: [{ src: 'https://example.com/icon.svg', mimeType: 'image/svg+xml', sizes: ['any'], theme: 'dark' as const }],
      _meta: { 'io.example/ui': { entry: 'view.html' } },
    };
    const provider = defineMcpProvider({
      id: 'catalog',
      tools: {
        lookup: defineMcpTool({ name: 'lookup', inputSchema: z.object({}), ...metadata }, async () => ({ content: [] })),
      },
      resources: {
        manual: defineMcpResource({
          kind: 'static', name: 'manual', uri: 'hile://catalog/manual', ...metadata,
          size: 42,
          annotations: { audience: ['assistant'], priority: 0.8 },
          cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
        }, async uri => ({ contents: [{ uri: uri.toString(), text: 'manual' }] })),
      },
      prompts: {
        summarize: defineMcpPrompt({ name: 'summarize', argsSchema: z.object({}), ...metadata }, async () => ({ messages: [] })),
      },
    });

    const manifest = createMcpProviderManifest(provider, {
      instanceId: 'a', namespace: 'catalog', address: { host: '127.0.0.1', port: 4100 },
    });

    expect(manifest.capabilities.tools[0]).toMatchObject(metadata);
    expect(manifest.capabilities.resources[0]).toMatchObject({
      ...metadata,
      size: 42,
      annotations: { audience: ['assistant'], priority: 0.8 },
      cacheHint: { ttlMs: 60_000, cacheScope: 'public' },
    });
    expect(manifest.capabilities.prompts[0]).toMatchObject(metadata);
  });
});
