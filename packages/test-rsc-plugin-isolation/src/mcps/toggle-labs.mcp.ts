import { defineMcpTool } from '@hile/mcp';
import { z } from 'zod';
import { toggleLabsProvider } from './labs-toggle';

export default defineMcpTool({
  name: 'toggle_labs',
  title: 'Toggle live MCP provider',
  description: 'Attaches or closes a loader-backed provider so connected clients receive list_changed.',
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ enabled: z.boolean() }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  access: { scopes: ['orders:write'] },
  execution: { retry: 'never', timeoutMs: 5_000 },
}, async () => {
  const enabled = await toggleLabsProvider();
  return {
    content: [{ type: 'text', text: `Labs provider ${enabled ? 'attached' : 'closed'}.` }],
    structuredContent: { enabled },
  };
});
