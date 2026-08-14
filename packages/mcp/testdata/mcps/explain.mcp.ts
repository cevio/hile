import { z } from 'zod';
import { defineMcpPrompt } from '../../src/index.js';

export default defineMcpPrompt(
  { name: 'explain', argsSchema: z.object({ topic: z.string() }) },
  async ({ topic }) => ({ messages: [{ role: 'user', content: { type: 'text', text: topic } }] }),
);
