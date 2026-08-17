# HttpNext

Package: `@hile/http-next`.

## Use When

Use `HttpNext` when a Next.js app and Hile API controllers should share the same HTTP server and port.

## Do Not Use When

- Do not use `@hile/http-next` for a pure API service; use `@hile/http`.
- Do not put Hile controllers inside `src/app`; the default convention is `src/controllers`.

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

- `HttpNext` keeps its internal `Http` instance private and exposes only `use()`, `load()`, and `start()`.
- Hile middleware and controllers run first; unmatched requests are passed to Next.js with the original Node request and response.
- Development mode is determined by `process.env.NODE_ENV === 'development'`.
- Controllers use `{cwd}/src/controllers` in development and `{cwd}/dist/controllers` in production with prefix `/-`.
- `load(directory)` explicitly loads an additional controller directory with the same fixed conventions.
- Call `use()` and `load()` before `start()`; configuration is frozen once startup begins.
- Next.js exclusively owns `public/`, `distDir`, `/_next/static`, RSC, Server Functions, and `next.config`.
- `start(onReady)` calls readiness only after Next is prepared and the shared HTTP server is listening.
- The returned async stop function first asks the shared HTTP server to stop accepting new connections, then waits for HTTP drain and Next runtime cleanup concurrently. It tracks and terminates upgraded connections, including development HMR WebSockets, because Node's HTTP drain does not own their protocol lifecycle. Development shutdown also closes disposable HTTP/compiler connections, matching Next's own development-server policy; production HTTP requests retain graceful drain behavior.
- Stop and startup rollback attempt both HTTP and Next cleanup even when either side fails. One failure is rethrown directly; multiple failures are reported together.

## Anti-Patterns

- Putting API routes in Next.js when the app is intentionally using Hile controllers.
- Calling `loadService()` at module top level in Next.js files.
- Serving Next.js `public/` or `/_next/static` through a separate Koa static middleware.
- Trying to override `distDir` at runtime instead of configuring it in `next.config`.
- Forgetting `cwd`; controller and Next project paths depend on it.

## Verification Checklist

- `HttpNext.start()` close function is registered with `shutdown`.
- Controllers live under the conventional `src/controllers` or `dist/controllers` directory.
- API routes use the fixed `/-` prefix.
- Next.js static assets and `public/` are served by Next.js itself.
- Next.js production build runs before `hile start` in production.
