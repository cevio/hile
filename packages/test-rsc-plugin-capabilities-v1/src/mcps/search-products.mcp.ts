import { defineMcpTool } from '@hile/mcp';
import { z } from 'zod';
import { products } from './data';

export default defineMcpTool({
  name: 'search_products', title: 'Search demo products',
  description: 'Searches the capability plugin catalog with streamed progress, logs, pagination and structured output.',
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).default(3), offset: z.number().int().min(0).default(0) }).strict(),
  outputSchema: z.object({ instance: z.string(), count: z.number().int(), total: z.number().int(), has_more: z.boolean(), products: z.array(z.object({ id: z.string(), name: z.string(), price: z.number() })) }),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: { scopes: ['catalog:read'] }, execution: { retry: 'idempotent-failover', timeoutMs: 5_000 },
}, async ({ query, limit, offset }, context) => {
  await context.emit.progress(0, 1, 'Searching catalog');
  const matched = products.filter(product => `${product.name} ${product.category}`.toLowerCase().includes(query.toLowerCase()));
  const page = matched.slice(offset, offset + limit);
  await context.emit.log('info', { message: 'Catalog search completed', query, matched: matched.length });
  await context.emit.progress(1, 1, 'Complete');
  const structuredContent = { instance: process.env.PLUGIN_MICRO_PORT ?? '4211', count: page.length, total: matched.length, has_more: offset + page.length < matched.length, products: page.map(({ id, name, price }) => ({ id, name, price })) };
  return { content: [{ type: 'text', text: page.map(product => `${product.id}: ${product.name} ($${product.price})`).join('\n') }], structuredContent };
});
