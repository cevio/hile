import { z, createControllerMetadata, defineController } from '@hile/http';

export default defineController(
  createControllerMetadata({
    method: 'POST',
    schema: {
      body: z.object({
        username: z.string(),
        age: z.number(),
      }),
    },
  }),
  async (ctx) => {
    const { username, age } = ctx.request.body;
    return { username, age };
  },
);
