---
name: redis-idempotency
description: Use when implementing duplicate-execution protection for Redis-backed Hile workflows, retries, queue consumers, message handlers, or write models.
---

# Redis Idempotency

Use `@hile/redis-idempotency` when a write operation may be retried or redelivered and must not run side effects twice.

## Core Rule

Package name names the backend; API names stay generic:

```typescript
import { stableHash, withIdempotency } from '@hile/redis-idempotency'
```

Wrap the smallest side-effecting function:

```typescript
return withIdempotency(
  redis,
  `idem:prod:wallet:debit:${tenantId}:${requestId}`,
  () => debitWallet(input),
  {
    lockTtl: 60_000,
    resultTtl: 86_400_000,
    fingerprint: stableHash(input),
  },
)
```

## Key Design

| Do | Avoid |
|---|---|
| Use business keys: `tenantId + requestId`, `orderId`, `providerTxnId` | Transport IDs, random UUID per retry |
| Include environment/service/operation prefix | Global keys like `idem:${id}` |
| Bind payload with `fingerprint` | Same key for different bodies |

## Serialization Boundaries

Build `stableHash()` fingerprints from plain DTOs. It rejects unsupported object types, sparse arrays, and circular references instead of silently treating `Map`, `Set`, or `RegExp` as `{}`.

Default cached results must be plain JSON values. If the wrapped function returns `Date`, `BigInt`, class instances, `Map` / `Set`, or any other rich type, pass `resultCodec` so cache hits deserialize to the same shape as the first call.

## Model Guidance

With `@hile/model@3.0.0+`, `defineModel()` returns `ctx.state.result` after the pipeline finishes, so `idempotent()` can short-circuit model execution when the middleware is created with an already available Redis client. Prefer function-level `withIdempotency()` inside `defineModel().main` when Redis is loaded through model `services`, or when only a smaller part of `main()` needs duplicate-execution protection.

## Failure Policy

High-risk writes should fail closed when Redis is unavailable. Do not bypass idempotency for money, quota, recharge, order creation, or notifications unless there is a stronger business-level unique constraint.

If the business function fails and releasing the `IN_FLIGHT` key also fails, `withIdempotency()` throws `AggregateError`; inspect both `errors` entries and assume the key may remain until `lockTtl`.

## Final Wall

Redis idempotency is not exactly-once. Keep DB unique constraints, transaction records, outbox rows, or provider idempotency keys for irreversible side effects.
