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
- Backslashes normalize to forward slashes.
- Parenthesized path segments are stripped by `normalizePath()`.

## Controller Responses

- Prefer returning values from `defineController` handlers.
- Response plugins transform returned values and write to `ctx.body`.
- Do not set `ctx.body` and also return a value from the same controller.
- Zod schemas validate request data but do not write parsed/coerced data back to `ctx.query`, `ctx.params`, or `ctx.request.body`.

## Model Layer

- `defineModel()` returns a definition.
- `loadModel(model, input)` runs the model every call.
- Model input must be an object.
- If pipelines are present, the final return value is read from `ctx.state.result`.

## Messaging

- Current message APIs return promises or streams directly.
- Do not append a secondary response getter to `request()`, `_send()`, or `Application.call()`.
- Use `call()` for single values and `stream()` only when the handler returns an async iterable.

## Distributed Guarantees

- Redis locks are leases.
- Redis stream queues are at-least-once.
- Redis idempotency reduces duplicate execution but is not exactly-once.
- Keep database unique constraints, outbox rows, fencing checks, or provider idempotency keys for irreversible side effects.
