import { defineMcpTool } from '@hile/mcp';
import { z } from 'zod';

export default defineMcpTool({
  name: 'ping',
  title: 'Labs provider ping',
  description: 'Appears and disappears live to demonstrate MCP list_changed discovery.',
  inputSchema: z.object({}).strict(),
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  access: { scopes: ['orders:write'] },
}, async () => ({ content: [{ type: 'text', text: 'labs provider ready' }] }));
