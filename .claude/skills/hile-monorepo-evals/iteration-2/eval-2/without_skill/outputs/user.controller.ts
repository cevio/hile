import { z } from 'zod';
import { createControllerMetadata, defineController } from '@hile/http';

const registerBodySchema = z.object({
  username: z.string(),
  age: z.number(),
});

export default defineController(
  createControllerMetadata({
    method: 'POST',
    schema: {
      body: registerBodySchema,
    },
  }),
  async (ctx) => {
    const { username, age } = ctx.request.body;
    return {
      message: 'User registered successfully',
      user: { username, age },
    };
  },
);
