# @hile/redis-idempotency

Redis-backed idempotency primitives for Hile services. The package name names the storage backend; the API names stay storage-neutral:

- `withIdempotency(redis, key, fn, options)` for functions, message handlers, jobs, and model `main()` bodies
- `idempotent(options)` for Koa-style `@hile/model` `Pipeline` middleware
- `stableHash(value)` for payload fingerprints

## Why this package exists

Retries are normal in distributed systems. `Application.call()` may retry after timeout, queues may redeliver a message, and users may submit the same form twice. If the retried operation writes money, quota, notifications, or orders, duplicate execution becomes a real business bug.

This package provides a shared Redis state machine:

```
FREE -> IN_FLIGHT(owner token) -> DONE(cached result)
```

The state lives in a single Redis key. Lua scripts atomically acquire, read, commit, and release the key so callers across processes share the same view.

Important boundary: Redis idempotency is not exactly-once. If the business side effect succeeds and the process crashes before the `DONE` state is committed, a later retry may run the function again. For money, quota, orders, and notifications, keep database unique constraints, transactions, outbox records, or provider idempotency keys as the final wall.

## Install

```bash
pnpm add @hile/redis-idempotency @hile/ioredis
```

The package accepts any Redis client matching `RedisLike`. In Hile apps, the usual client comes from `@hile/ioredis`:

```typescript
import { loadService } from '@hile/core'
import redisService from '@hile/ioredis'

const redis = await loadService(redisService)
```

## Quick Start

```typescript
import { loadService } from '@hile/core'
import redisService from '@hile/ioredis'
import { stableHash, withIdempotency } from '@hile/redis-idempotency'

const redis = await loadService(redisService)

async function debitWallet(input: {
  tenantId: string
  requestId: string
  amount: number
}) {
  return withIdempotency(
    redis,
    `idem:prod:wallet:debit:${input.tenantId}:${input.requestId}`,
    async () => {
      // Put the side-effecting operation here.
      return performDebit(input)
    },
    {
      lockTtl: 60_000,
      resultTtl: 24 * 60 * 60 * 1000,
      fingerprint: stableHash(input),
    },
  )
}
```

What happens:

1. First caller writes `IN_FLIGHT` and runs `performDebit`.
2. Concurrent callers with the same key and fingerprint wait for `DONE`.
3. Later callers with the same key and fingerprint receive the cached result.
4. Same key with a different fingerprint throws `IdempotencyPayloadMismatchError`.
5. If `performDebit` throws, the `IN_FLIGHT` key is released so a retry can run.

## API

### withIdempotency(redis, key, fn, options)

```typescript
function withIdempotency<T>(
  redis: RedisLike,
  key: string,
  fn: () => Promise<T>,
  options: IdempotencyOptions<T>,
): Promise<T>
```

`key` must already include the full namespace. A safe format is:

```
idem:{env}:{service}:{operation}:{tenantId}:{businessId}
```

Do not use transport message IDs as business keys. Prefer request IDs, order IDs, provider transaction IDs, or ledger IDs.

#### IdempotencyOptions

| Option | Required | Meaning |
|---|---:|---|
| `lockTtl` | yes | How long the `IN_FLIGHT` owner may run before Redis expires the key. Must exceed normal business execution time. |
| `resultTtl` | yes | How long the successful `DONE` result is cached. Must cover the retry/redelivery window. |
| `fingerprint` | yes | Stable hash of the payload. Prevents reusing one key for different requests. |
| `wait` | no | How long a concurrent caller waits for `DONE`. Defaults to `lockTtl`. |
| `onConflict` | no | `'wait'` or `'reject'`. Defaults to `'wait'`. |
| `pollInterval` | no | Initial polling delay in ms. Defaults to `20`. |
| `maxPollInterval` | no | Max polling delay in ms. Defaults to `500`. |
| `resultCodec` | no | Custom result serializer/deserializer for non-JSON return values. |

#### Result serialization

By default, cached results must be plain JSON values: `null`, strings, finite numbers, booleans, arrays, and plain objects. The package rejects `Date`, `Map`, `Set`, `BigInt`, functions, symbols, circular references, sparse arrays, class instances, and nested `undefined` values instead of caching a lossy value.

Use `resultCodec` when the function returns richer types:

```typescript
const resultCodec = {
  serialize: (value: { createdAt: Date }) => JSON.stringify({
    createdAt: value.createdAt.toISOString(),
  }),
  deserialize: (raw: string) => {
    const value = JSON.parse(raw) as { createdAt: string }
    return { createdAt: new Date(value.createdAt) }
  },
}

await withIdempotency(redis, key, createRecord, {
  lockTtl: 60_000,
  resultTtl: 86_400_000,
  fingerprint,
  resultCodec,
})
```

### stableHash(value)

```typescript
const fingerprint = stableHash({
  method: 'POST',
  path: '/-/wallet/debit',
  tenantId,
  body,
})
```

`stableHash` sorts plain object keys before hashing, so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` produce the same fingerprint. It rejects unsupported object types, sparse arrays, and circular references instead of hashing them as `{}`; build fingerprints from plain request DTOs.

### idempotent(options)

`idempotent()` is a Koa-style `PipelineMiddleware`. It wraps `await next()`, caches `ctx.state.result`, and writes cached results back to `ctx.state.result`.

```typescript
import { Pipeline, PipelineContext } from '@hile/model'
import { idempotent, stableHash } from '@hile/redis-idempotency'

const pipeline = new Pipeline<{ tenantId: string; requestId: string }>()
pipeline.use(idempotent({
  redis,
  key: (input) => `idem:prod:wallet:debit:${input.tenantId}:${input.requestId}`,
  fingerprint: stableHash,
  lockTtl: 60_000,
  resultTtl: 86_400_000,
}))
pipeline.use(async (ctx) => {
  ctx.state.result = await performDebit(ctx.args)
})

const ctx = new PipelineContext({ tenantId: 't1', requestId: 'r1' })
await pipeline.dispatch(ctx)
console.log(ctx.state.result)
```

With `@hile/model@3.0.0+`, `defineModel()` returns `ctx.state.result` after the pipeline finishes, so `idempotent()` can be used directly as model middleware when the middleware is created with an already available Redis client. A cached idempotency hit can short-circuit the pipeline and still become the model result:

```typescript
function createDebitModel(redis: Redis) {
  return defineModel({
    pipelines: [
      idempotent({
        redis,
        key: (input: DebitInput) => `idem:prod:wallet:debit:${input.tenantId}:${input.requestId}`,
        fingerprint: stableHash,
        lockTtl: 60_000,
        resultTtl: 86_400_000,
      }),
    ],
    async main(input: DebitInput) {
      return performDebit(input, redis)
    },
  })
}
```

For normal Hile models that load Redis through `services: [redisService]`, or for code that needs a narrower critical section than the whole model, use function-level `withIdempotency()` inside `main()` instead.

## Error Types

| Error | When it happens | Recommended handling |
|---|---|---|
| `IdempotencyConflictError` | Same key is already `IN_FLIGHT` and `onConflict: 'reject'` | Return 409 or let queue retry later |
| `IdempotencyTimeoutError` | Waited for `DONE` longer than `wait` | Retry with the same key |
| `IdempotencyPayloadMismatchError` | Same key was reused with a different fingerprint | Treat as caller bug or replay risk |
| `IdempotencyOwnershipLostError` | Owner finished after losing the Redis key | Investigate `lockTtl`; business side effect may have run |
| `IdempotencyRetryableError` | In-flight key disappeared before `DONE` was visible | Retry with the same key |
| `AggregateError` | The wrapped function failed and releasing the `IN_FLIGHT` key also failed | Inspect both `errors`; the key may remain until `lockTtl` |

## TTL Guidance

| Scenario | `lockTtl` | `resultTtl` |
|---|---:|---:|
| HTTP form submit | max handler time + margin | 5-30 minutes |
| Internal `Application.call()` write | max handler time + margin | max retry window |
| Kafka / queue consumer | max handler time + margin | 24h or redelivery SLA |
| Payment/recharge callback | max handler time + margin | 24h+ or provider retry SLA |

If a job can run longer than a predictable `lockTtl`, do not use this package as-is for that job until lease renewal exists.

## Testing

```bash
pnpm --filter @hile/redis-idempotency test
pnpm --filter @hile/redis-idempotency build
```

## License

MIT
