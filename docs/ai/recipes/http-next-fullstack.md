# HttpNext Fullstack App

## Complete Example

Boot:

```ts
// src/services/http.boot.ts
import { defineService } from '@hile/core'
import HttpNext from '@hile/http-next'

export default defineService('http.next', async (shutdown) => {
  const app = new HttpNext({
    port: Number(process.env.HTTP_PORT ?? 3000),
    cwd: process.cwd(),
  })
  const stop = await app.start()
  shutdown(stop)
  return app
})
```

API controller:

```ts
// src/controllers/post.controller.ts
import { defineController } from '@hile/http'
import { loadModel } from '@hile/model'
import { getPost } from '../models/post/get-post.model'

export default defineController('GET', async () => {
  return loadModel(getPost, { id: 'demo' })
})
```

Next.js page:

```tsx
// src/app/page.tsx
import { loadModel } from '@hile/model'
import { getPost } from '../models/post/get-post.model'

export const dynamic = 'force-dynamic'

export default async function Page() {
  const post = await loadModel(getPost, { id: 'demo' })
  return <main>{post.title}</main>
}
```

Model:

```ts
// src/models/post/get-post.model.ts
import { defineModel } from '@hile/model'

export const getPost = defineModel(async (input: { id: string }) => {
  return { id: input.id, title: 'Hello from Hile' }
})
```

## File Layout

```text
src/
  app/page.tsx
  controllers/post.controller.ts
  models/post/get-post.model.ts
  services/http.boot.ts
```

## User Intent

Use this recipe when the user wants Next.js pages and Hile API controllers on one server.

## Packages To Use

- `@hile/http-next`
- `@hile/http`
- `@hile/model`
- `@hile/core`

## Implementation Steps

1. Put shared data logic in a model.
2. Use `HttpNext` in a boot service.
3. Put Hile APIs in `src/controllers`.
4. Put pages in `src/app`.
5. Mark pages dynamic when they call runtime models.

## Failure And Cleanup Behavior

- `HttpNext.start()` returns an async stop function; register it with `shutdown()`.
- Hile API controllers run first and Next.js is the final raw request fallback.
- Next.js owns `public/`, build assets, RSC, Server Functions, and graceful runtime cleanup.

## Verification Checklist

- API route is under `/-` by default.
- `cwd` points to the project root.
- Production runs TypeScript build and Next build before `hile start`.
