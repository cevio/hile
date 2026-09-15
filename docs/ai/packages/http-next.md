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

Next.js App Router modules that need the request cancellation signal must use
the lightweight subpath so their page bundle does not traverse the custom
server entrypoint:

```ts
import { getHttpNextRequestSignal } from '@hile/http-next/request-signal'
```

The package root re-exports `getHttpNextRequestSignal` for existing server-side
consumers, but App Router modules must not import the root because it owns the
runtime `next` custom-server dependency.

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

HttpNext inherits the `@hile/http` file-route DSL. A Gateway fallback such as `src/controllers/[namespace]/[...paths].controller.ts` matches `/-/blog/assets/logo.svg` and exposes `ctx.params.namespace === 'blog'` plus `ctx.params.paths === 'assets/logo.svg'`. The safe `[...paths]` file name is retained by npm and works on Windows; do not use a literal `*.controller.ts` catch-all file.

Use `loadModel()` from pages or controllers for domain logic. If a Next.js page uses runtime model data, mark the route dynamic:

```tsx
export const dynamic = 'force-dynamic'
```

`HttpNextProps` composes the complete `HttpProps` contract. A deployment behind one trusted TLS-terminating reverse proxy can therefore configure the shared Koa/Next listener directly:

```ts
const app = new HttpNext({
  port: 3000,
  cwd: process.cwd(),
  proxy: true,
  maxIpsCount: 1,
})
```

The proxy must replace forwarded headers, set `X-Forwarded-Proto: https`, and be the only network path to the Hile listener. Hile middleware and controllers use the configured Koa proxy semantics; unmatched requests still reach Next.js as the original Node request with the same sanitized headers. This is transport configuration, not application policy.

## Compose With

- Use `@hile/model` for business logic shared by controllers and pages.
- Use `@hile/http` controllers under `src/controllers`.
- Use `@hile/micro` from services or models, not directly as hidden global state in page modules.

## Runtime And Lifecycle Notes

- `HttpNext` keeps its internal `Http` instance private and exposes only `use()`, `load()`, and `start()`.
- Except for `cwd`, constructor options are the `HttpProps` passed unchanged to the shared `Http` instance, including complete Koa options, bounded reverse-proxy trust, and router options.
- Hile middleware and controllers run first; unmatched requests are passed to Next.js with the original Node request and response.
- `@hile/http-next/request-signal` is the Next-free App Router entrypoint for reading the current request's cancellation signal.
- Concurrent requests, multiple `HttpNext` instances, and compatible package copies in one JavaScript realm share one storage identity while retaining isolated asynchronous contexts. Separate PM2 processes, Workers, or VM realms intentionally keep independent request signals.
- Development mode is determined by `process.env.NODE_ENV === 'development'`.
- Controllers use `{cwd}/src/controllers` in development and `{cwd}/dist/controllers` in production with prefix `/-`.
- Required catch-all controllers use the same `[...name]` final-segment convention as `@hile/http`; unmatched requests alone continue to Next.js.
- `load(directory)` explicitly loads an additional controller directory with the same fixed conventions.
- Call `use()` and `load()` before `start()`; configuration is frozen once startup begins.
- Next.js exclusively owns `public/`, `distDir`, `/_next/static`, RSC, Server Functions, and `next.config`.
- `start(onReady)` calls readiness only after Next is prepared and the shared HTTP server is listening.
- The returned async stop function first asks the shared HTTP server to stop accepting new connections, then waits for HTTP drain and Next runtime cleanup concurrently. It tracks and terminates upgraded connections, including development HMR WebSockets, because Node's HTTP drain does not own their protocol lifecycle. Development shutdown also closes disposable HTTP/compiler connections, matching Next's own development-server policy; production HTTP requests retain graceful drain behavior.
- Normal stop attempts HTTP, Next, and startup-loaded controller cleanup even when one side fails. One cleanup failure is rethrown directly and multiple cleanup failures are reported together. Startup rollback also attempts every acquired cleanup, then preserves the original startup error.

## Anti-Patterns

- Putting API routes in Next.js when the app is intentionally using Hile controllers.
- Importing the `@hile/http-next` root from an App Router module; import request cancellation from `@hile/http-next/request-signal` instead.
- Calling `loadService()` at module top level in Next.js files.
- Serving Next.js `public/` or `/_next/static` through a separate Koa static middleware.
- Trying to override `distDir` at runtime instead of configuring it in `next.config`.
- Forgetting `cwd`; controller and Next project paths depend on it.
- Treating `proxy: true` as a substitute for restricting direct listener access and sanitizing forwarded headers at the edge.

## Verification Checklist

- `HttpNext.start()` close function is registered with `shutdown`.
- Controllers live under the conventional `src/controllers` or `dist/controllers` directory.
- API routes use the fixed `/-` prefix.
- Next.js static assets and `public/` are served by Next.js itself.
- Next.js production build runs before `hile start` in production.
- App Router modules that read the request signal compile without Next.js's `import-next` warning.
- Reverse-proxy settings describe the actual trusted hop topology and apply consistently to Koa and Next requests on the shared server.
