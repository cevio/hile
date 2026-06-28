# HttpNext

Package: `@hile/http-next`.

## Use When

Use `HttpNext` when a Next.js app and Hile API controllers should share the same HTTP server and port.

## Do Not Use When

- Do not use `@hile/http-next` for a pure API service; use `@hile/http`.
- Do not put Hile controllers inside `src/app` unless you intentionally change `controllerDirectory`.

## Install

```bash
pnpm add @hile/http-next @hile/http next react react-dom
pnpm add -D @hile/cli
```

## Imports

```ts
import HttpNext from '@hile/http-next'
import { defineService } from '@hile/core'
```

## Copy-Paste Example

```ts
// src/services/http.boot.ts
import { defineService } from '@hile/core'
import HttpNext from '@hile/http-next'

export default defineService('http.next', async (shutdown) => {
  const app = new HttpNext({
    port: Number(process.env.HTTP_PORT ?? 3000),
    cwd: process.cwd(),
    publicPath: 'public',
  })
  const stop = await app.start()
  shutdown(stop)
  return app
})
```

## More Examples

Recommended layout:

```text
src/
  app/              Next.js App Router pages
  controllers/      Hile API controllers, default prefix /-
  models/           Reusable business logic
  services/         *.boot.ts and app services
```

Use `loadModel()` from pages or controllers for domain logic. If a Next.js page uses runtime model data, mark the route dynamic:

```tsx
export const dynamic = 'force-dynamic'
```

## Compose With

- Use `@hile/model` for business logic shared by controllers and pages.
- Use `@hile/http` controllers under `src/controllers`.
- Use `@hile/micro` from services or models, not directly as hidden global state in page modules.

## Runtime And Lifecycle Notes

- `HttpNext` wraps an internal `Http` instance.
- It serves `publicPath`, then `.next/static`, then Hile controllers, then Next.js as the fallback handler.
- Development mode is determined by `process.env.NODE_ENV === 'development'`.
- Controller directory is `{cwd}/src/{controllerDirectory}` in development and `{cwd}/dist/{controllerDirectory}` in production.
- `specialControllers` load additional controller roots with their own prefixes.

## Anti-Patterns

- Putting API routes in Next.js when the app is intentionally using Hile controllers.
- Calling `loadService()` at module top level in Next.js files.
- Forgetting `cwd`; relative controller and Next artifact paths depend on it.

## Verification Checklist

- `HttpNext.start()` close function is registered with `shutdown`.
- Controllers live under the configured controller directory.
- API routes use the configured prefix, default `/-`.
- Next.js production build runs before `hile start` in production.
