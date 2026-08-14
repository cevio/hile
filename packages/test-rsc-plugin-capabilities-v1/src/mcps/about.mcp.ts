import { defineMcpResource } from '@hile/mcp';

export default defineMcpResource({
  kind: 'static', name: 'about', title: 'Catalog service', description: 'Static catalog service documentation.',
  uri: 'demo://catalog/about', mimeType: 'text/markdown', size: 112,
  icons: [{ src: 'https://example.com/icons/catalog-docs.svg', mimeType: 'image/svg+xml' }],
  annotations: { audience: ['assistant'], priority: 0.8 },
  cacheHint: { ttlMs: 60_000, cacheScope: 'private' },
  _meta: { 'demo.hile.dev/source': 'static-resource' },
  access: { scopes: ['catalog:read'] },
}, async () => ({ contents: [{ uri: 'demo://catalog/about', mimeType: 'text/markdown', text: '# RSC catalog MCP\nServed by test-rsc-plugin-capabilities-v1.' }] }));
