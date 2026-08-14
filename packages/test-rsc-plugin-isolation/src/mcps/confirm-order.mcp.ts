import { defineMcpTool } from '@hile/mcp';
import { acceptedContent, inputRequired } from '@modelcontextprotocol/server';
import { z } from 'zod';

export default defineMcpTool({
  name: 'confirm_order', title: 'Confirm demo order', description: 'Demonstrates MCP 2026 multi-round-trip elicitation.',
  inputSchema: z.object({ order_id: z.string().regex(/^order-[A-Za-z0-9-]+$/) }).strict(),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: { scopes: ['orders:write'] }, execution: { retry: 'never', timeoutMs: 5_000 },
}, async ({ order_id }, context) => {
  const confirmation = acceptedContent<{ confirmed: boolean }>(context.inputResponses, 'confirmation');
  if (!confirmation) return inputRequired({ inputRequests: { confirmation: inputRequired.elicit({
    message: `Confirm demo order ${order_id}?`, requestedSchema: z.object({ confirmed: z.boolean() }),
  }) } });
  if (!confirmation.confirmed) return { isError: true, content: [{ type: 'text', text: `Order ${order_id} was not confirmed.` }] };
  return { content: [{ type: 'text', text: `Order ${order_id} confirmed.` }] };
});
