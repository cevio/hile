import { z } from 'zod'
import { createControllerMetadata, defineController } from '@hile/http'

const meta = createControllerMetadata({
  method: 'POST',
  middlewares: [],
  schema: {
    body: z.object({
      username: z.string(),
      age: z.number(),
    }),
  },
})

export default defineController(meta, async (ctx) => {
  const { username, age } = ctx.request.body
  return { ok: true, user: { username, age } }
})
