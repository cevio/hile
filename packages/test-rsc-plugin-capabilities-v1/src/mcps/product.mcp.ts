import { defineMcpResource } from '@hile/mcp';
import { findProduct, products } from './data';

export default defineMcpResource({
  kind: 'template', name: 'product', title: 'Product detail', description: 'Reads one product through an RFC 6570 resource template.',
  uriTemplate: 'demo://catalog/products/{id}', mimeType: 'application/json', size: 256,
  icons: [{ src: 'https://example.com/icons/catalog-product.svg', mimeType: 'image/svg+xml', theme: 'dark' }],
  annotations: { audience: ['assistant'], priority: 0.9 },
  cacheHint: { ttlMs: 15_000, cacheScope: 'private' },
  _meta: { 'demo.hile.dev/source': 'registry-provider' },
  completions: {
    id: async value => products.map(product => product.id).filter(id => id.startsWith(value)),
  },
  access: { scopes: ['catalog:read'] },
}, async (variables) => {
  const raw = variables.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  const product = id ? findProduct(id) : undefined;
  if (!product) throw new Error(`Unknown demo product: ${id ?? '(missing id)'}`);
  return { contents: [{ uri: `demo://catalog/products/${product.id}`, mimeType: 'application/json', text: JSON.stringify(product) }] };
});
