import { defineMcpResource } from '@hile/mcp';
import { findProduct } from './data';

export default defineMcpResource({
  kind: 'template', name: 'product', title: 'Product detail', description: 'Reads one product through an RFC 6570 resource template.',
  uriTemplate: 'demo://catalog/products/{id}', mimeType: 'application/json', access: { scopes: ['catalog:read'] },
}, async (variables) => {
  const raw = variables.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  const product = id ? findProduct(id) : undefined;
  if (!product) throw new Error(`Unknown demo product: ${id ?? '(missing id)'}`);
  return { contents: [{ uri: `demo://catalog/products/${product.id}`, mimeType: 'application/json', text: JSON.stringify(product) }] };
});
