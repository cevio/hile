import { defineMcpResource } from '@hile/mcp';

export default defineMcpResource({
  kind: 'static', name: 'about', title: 'Catalog service', description: 'Static catalog service documentation.',
  uri: 'demo://catalog/about', mimeType: 'text/markdown', access: { scopes: ['catalog:read'] },
}, async () => ({ contents: [{ uri: 'demo://catalog/about', mimeType: 'text/markdown', text: '# RSC catalog MCP\nServed by test-rsc-plugin-capabilities-v1.' }] }));
