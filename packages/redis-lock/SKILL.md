---
name: redis-lock
description: Use when implementing Redis-backed mutual exclusion, single-instance jobs, cache singleflight, lease renewal, or fencing-token protected critical sections in Hile packages.
---

# Redis Lock

Use `@hile/redis-lock` when one process should own a Redis-backed critical section for a limited lease.

## Core Rule

Use `RedisLock` for normal business logic and dependency injection:

```typescript
const locks = new RedisLock(redis, {
  prefix: 'orders:',
  defaultTtl: 30_000,
})

await locks.withLock(`lock:order:${orderId}`, {
  wait: 2_000,
}, async ({ fencingToken }) => {
  await updateOrder(orderId, fencingToken)
})
```

The top-level `withLock()` and `tryLock()` functions are compatibility wrappers. Use instance methods when adding package integrations. Use `tryLock()` only when the caller needs manual control:

```typescript
const lock = await locks.tryLock('lock:job:daily')
if (!lock) return

try {
  await runJob()
} finally {
  await lock.release()
}
```

## Design Boundaries

- The lock key stores only the owner token.
- Release and renew always use Lua compare-owner scripts.
- `withLock()` asserts ownership before returning a successful callback result.
- Enable `fencing` when the protected resource can reject stale writes.
- Do not use this package as an exactly-once guarantee. Pair it with database constraints, idempotency records, outbox rows, or fencing-token checks for irreversible work.

## Relationship To Other Packages

- `@hile/redis-idempotency` should use this package for lock ownership and waiting, while keeping its own idempotency state key.
- `@hile/schedule` distributed mode should use this package to ensure only one replica runs a job.
- `@hile/cache` singleflight should use this package to ensure only one caller refreshes a missing or stale key.

## Error Policy

Handle these errors explicitly:

- `LockConflictError`: return skip/409/retry-later depending on the workflow.
- `LockTimeoutError`: retry later or surface timeout.
- `LockOwnershipLostError`: treat the callback result as unsafe.
- `LockRenewalError`: stop long-running work when possible.
