import { defineMcpPrompt } from '@hile/mcp';
import { z } from 'zod';

export default defineMcpPrompt({
  name: 'recommend_products', title: 'Recommend products', description: 'Builds a grounded product recommendation prompt.',
  argsSchema: z.object({ need: z.string().min(1) }).strict(), access: { scopes: ['catalog:read'] },
}, async ({ need }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Recommend catalog products for: ${need}. Read demo://catalog/about first.` } }] }));
