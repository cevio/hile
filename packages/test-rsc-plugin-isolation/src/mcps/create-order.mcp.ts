import { defineMcpTool } from '@hile/mcp';
import { z } from 'zod';

export default defineMcpTool({
  name: 'create_order', title: 'Create demo order', description: 'Creates an isolated demo order with structured output.',
  inputSchema: z.object({ product_id: z.string().regex(/^p-\d+$/), quantity: z.number().int().min(1).max(10) }).strict(),
  outputSchema: z.object({ order_id: z.string(), status: z.literal('created') }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  access: { scopes: ['orders:write'] }, execution: { retry: 'never', timeoutMs: 5_000 },
}, async ({ product_id, quantity }, context) => {
  await context.emit.log('notice', { message: 'Demo order created', product_id, quantity });
  const structuredContent = { order_id: `order-${product_id}-${quantity}`, status: 'created' as const };
  return { content: [{ type: 'text', text: `Created ${structuredContent.order_id}` }], structuredContent };
});
