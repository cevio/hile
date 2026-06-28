# Hile Anti-Patterns

## Never Generate These Patterns

- Do not call `loadService()` at module top level; it starts resources during import.
- Do not default-export plain functions from `*.boot.*` files; `hile start` expects a Hile service.
- Do not set `ctx.body` and also return a controller value.
- Do not assume `@hile/http` Zod validation mutates or coerces `ctx.query`, `ctx.params`, or `ctx.request.body`.
- Do not put reusable business logic only in controllers, pages, queue workers, or message handlers.
- Do not use old message examples that append a secondary response getter; current request APIs return promises directly.
- Do not claim exactly-once delivery or execution from Redis locks, queues, idempotency, or rate limits.
- Do not use queue `jobId` as the only side-effect idempotency boundary.
- Do not log the entire async context by default.

## Lifecycle

Avoid:

```ts
const db = await loadService(typeormService)
```

at module top level. It starts resources during import. Use `loadService()` inside a service factory, controller, model, or handler.

Avoid default-exporting plain functions from boot files. `hile start` expects the default export to pass `isService()`.

## HTTP

Avoid:

```ts
export default defineController('GET', async (ctx) => {
  ctx.body = { ok: true }
  return { ok: true }
})
```

Return a value, or write `ctx.body`, but do not mix both.

Avoid assuming Zod coercion has rewritten Koa context values. The current controller implementation validates only.

## Model

Avoid putting business logic only in controllers or Next.js pages when it needs reuse. Put domain logic in `@hile/model`, then call `loadModel()`.

Avoid calling `loadModel(model, primitive)`. Model input must be an object.

## Messaging

Avoid old message examples that append a second response getter after `request()`.

Current APIs return the response promise directly:

```ts
const result = await client.request('/x', data)
```

Avoid `stream()` for single-value RPC. It requires the remote handler to return an async iterable.

## Redis

Avoid claiming "exactly once" for Redis locks, idempotency, queues, or rate limits.

Avoid random UUIDs as idempotency keys. Use business keys such as order id, provider transaction id, tenant id plus request id, or ledger id.

Avoid treating queue `jobId` as side-effect idempotency. It dedupes enqueue attempts, not handler effects.

Avoid using locks as the final consistency wall for money, quota, orders, or notifications. Use database constraints, transactions, outbox records, fencing tokens, or provider idempotency keys.

## Context

Avoid baking app-specific fields into `@hile/context`. The package stores and propagates context; applications define the shape.

Avoid logging the whole context by default. Use `withContextLogger(logger, { pick })` or `{ map }`.
