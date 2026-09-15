# Hile Conventions

## Runtime

- Use Node.js >= 20.12.
- Use ESM. Projects should set `"type": "module"` in `package.json`.
- Use `pnpm` in examples unless the existing project uses another package manager.

## Boot Files

- Boot files are service files named `*.boot.ts` in development and `*.boot.js` after build.
- `hile start --dev` scans `src/**/*.boot.{ts,js}`.
- `hile start` scans `dist/**/*.boot.{ts,js}`.
- A boot file should default-export a value returned by `defineService()`.
- Do not call `loadService()` at module top level. Call it inside service factories, controllers, models, handlers, or request functions.

```ts
import { defineService } from '@hile/core'
import { Http } from '@hile/http'

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: Number(process.env.HTTP_PORT ?? 3000) })
  await http.load(new URL('../controllers', import.meta.url).pathname)
  const close = await http.listen()
  shutdown(close)
  return http
})
```

## Service Keys

- Application services should use clear string keys such as `'http'`, `'micro.app'`, or `'db.reporting'`.
- Integration packages use `Symbol.for(packageName)` internally.
- Reusing the same key for different factories means the first resolved service wins.

## File-System Routes

Hile uses `@hile/loader` conventions:

- `index.controller.ts` with default suffix `/index` maps to the parent path.
- `[id].controller.ts` maps to `:id`.
- `[...paths].controller.ts` is a required catch-all. It matches one or more remaining segments and exposes their slash-joined value as `ctx.params.paths`.
- Backslashes normalize to forward slashes.
- Parenthesized path segments are stripped by `normalizePath()`.
- Dynamic and catch-all declarations must occupy a complete segment, use a safe JavaScript identifier, avoid object-meta names (`__proto__`, `prototype`, `constructor`), and have a unique name within the route. A catch-all must be last and unique. Optional catch-all (`[[...paths]]`), mixed segments, duplicate or object-meta names, non-terminal catch-all, and router-native file names are rejected during loading with the file path in the error.
- Use `[...paths]` instead of a literal `*` file name. It is portable across npm packing and Windows, while Hile compiles it to the active router's native syntax.

## Controller Responses

- Prefer returning values from `defineController` handlers.
- Response plugins transform returned values and write to `ctx.body`.
- Do not set `ctx.body` and also return a value from the same controller.
- Zod schemas validate request data but do not write parsed/coerced data back to `ctx.query`, `ctx.params`, or `ctx.request.body`.

## Model Layer

- `defineModel()` returns a definition.
- `loadModel(model, input, invocation)` runs the model every call with an explicit execution context and cancellation signal.
- Model input must be an object.
- If pipelines are present, the final return value is read from `ctx.state.result`.

## Messaging

- Current message APIs return promises or streams directly.
- Do not append a secondary response getter to `request()`, `_send()`, or `Application.call()`.
- Use `call()` for single values and `stream()` only when the handler returns an async iterable.
- HTTP-over-Micro is the exception to that last selection rule: use `callHttpOverMicro()`, which internally opens one response stream so response metadata can precede an optional streamed body.
- Preserve duplicate HTTP headers as ordered tuples across Micro. Keep public authentication, cookie, redirect, and forwarded-header policy at the HTTP gateway.

## Distributed Guarantees

- Redis locks are leases.
- Redis stream queues are at-least-once.
- Redis idempotency reduces duplicate execution but is not exactly-once.
- Keep database unique constraints, outbox rows, fencing checks, or provider idempotency keys for irreversible side effects.
