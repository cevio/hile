# HTTP And File Routes

Packages: `@hile/http`, `@hile/loader`.

## Use When

Use `@hile/http` for Koa-based APIs, middleware, manual routes, file-system controllers, Zod validation, and response plugins.

## Do Not Use When

- Do not use it for Next.js pages; use `@hile/http-next` when Next.js and API routes share a port.
- Do not assume Zod validation mutates/coerces Koa context data. It validates only.

## Install

```bash
pnpm add @hile/http
```

## Imports

```ts
import { Http, defineController, createControllerMetadata, defineResponsePlugin } from '@hile/http'
import { z } from 'zod'
```

## Copy-Paste Example

```ts
import { defineController } from '@hile/http'

export default defineController('GET', async () => {
  return { ok: true }
})
```

File route examples:

```text
src/controllers/index.controller.ts -> /
src/controllers/users/index.controller.ts -> /users
src/controllers/users/[id].controller.ts -> /users/:id
```

## More Examples

```ts
import { z } from 'zod'
import { createControllerMetadata, defineController } from '@hile/http'

const bodySchema = z.object({
  username: z.string().min(1),
  age: z.number().int().nonnegative(),
})

export default defineController(
  createControllerMetadata({
    method: 'POST',
    schema: { body: bodySchema },
  }),
  async (ctx) => {
    const body = bodySchema.parse(ctx.request.body)
    return { created: true, user: body }
  },
)
```

The second parse is intentional when you need parsed/coerced data. Hile's controller validation does not write `safeParse().data` back to `ctx.request.body`.

## Compose With

- Call `loadModel()` from controllers to keep business logic out of HTTP files.
- Create an `ExecutionContext` at controller ingress and explicitly pass its `InvocationContext` to models and its carrier to transports.
- Use `rateLimitHttp()` for Redis-backed HTTP quotas.

## Runtime And Lifecycle Notes

- `new Http({ port })` creates a Koa app and a `find-my-way` router.
- `http.use(middleware)` registers Koa middleware before `listen()`.
- `http.listen()` returns a close function.
- `http.load(directory, options)` scans `*.controller.{ts,js,tsx,jsx,mjs}` by suffix.
- `defineController()` supports method-only, method-plus-middlewares, and metadata-plus-Zod forms.
- Response plugins transform handler return values and set `ctx.body` when the final result is not `undefined`.

## Anti-Patterns

- Setting `ctx.body` and returning a value from the same controller.
- Loading controllers after starting only because an old example does it; prefer load before listen in new code.
- Using old validation examples that assume Zod coercion rewrote `ctx.query`.

## Verification Checklist

- Controller files default-export `defineController(...)` or an array of controllers.
- Controllers return response values.
- Boot service awaits `http.load()` before `http.listen()`.
- Zod schemas are used for validation, and parsed data is explicitly parsed when needed.
