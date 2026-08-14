import { defineMcpTool } from '@hile/mcp';
import { z } from 'zod';
import { findProduct } from './data';
import { notifyProductResourceUpdated } from './resource-updates';

export default defineMcpTool({
  name: 'touch_product',
  title: 'Publish product update',
  description: 'Publishes an official MCP resource-updated notification for a subscribed product URI.',
  inputSchema: z.object({ id: z.string().regex(/^p-\d+$/) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: { scopes: ['catalog:read'] },
  execution: { retry: 'never', timeoutMs: 5_000 },
}, async ({ id }) => {
  if (!findProduct(id)) throw new Error(`Unknown demo product: ${id}`);
  await notifyProductResourceUpdated(id);
  return { content: [{ type: 'text', text: `Published resource update for demo://catalog/products/${id}` }] };
});
