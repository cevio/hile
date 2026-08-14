import { z } from 'zod';
import { defineMcpTool } from '../../src/index.js';

export default defineMcpTool(
  { name: 'echo', inputSchema: z.object({ value: z.string() }) },
  async ({ value }) => ({ content: [{ type: 'text', text: value }] }),
);
