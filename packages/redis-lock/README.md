# @hile/redis-lock

Redis-backed lease locks for Hile services. 从 3.0.0 开始，新增或重构的 Hile 架构包统一进入 3.x 版本线，2.x 时代结束。

Use this package when only one process should run a critical section at a time: distributed cron jobs, cache singleflight refreshes, state transitions, migrations, inventory updates, and similar workflows.

## Install

```bash
pnpm add @hile/redis-lock
```

The package accepts any Redis client matching `RedisLockLike`. In Hile apps the usual client comes from `@hile/ioredis`:

```typescript
import { loadService } from '@hile/core'
import redisService from '@hile/ioredis'

const redis = await loadService(redisService)
```

## Quick Start

```typescript
import { RedisLock } from '@hile/redis-lock'

const locks = new RedisLock(redis, {
  prefix: 'myapp:',
  defaultTtl: 30_000,
})

await locks.withLock(`lock:order:${orderId}`, {
  wait: 2_000,
}, async () => {
  await updateOrder(orderId)
})
```

What happens:

1. The first caller writes an owner token into Redis with `SET NX PX`.
2. Other callers either fail immediately or wait, depending on `wait`.
3. The owner runs the callback.
4. Before returning, `withLock()` checks that the owner token is still present.
5. The lock is released with a Lua compare-owner-and-delete script.

## API

### RedisLock

`RedisLock` 是主 API，适合在服务初始化时创建一次并注入给上层包或业务代码。

```typescript
const locks = new RedisLock(redis, {
  prefix: 'billing:',
  defaultTtl: 30_000,
  wait: 2_000,
})

await locks.withLock('invoice:sync', async (lease) => {
  await syncInvoices(lease.token)
})
```

实例默认值可被单次调用覆盖。`prefix` 会应用到实例方法传入的 key。

### RedisLockLease

`tryLock()` 和 `withLock()` 回调拿到的是 `RedisLockLease` 实例，包含 `key`、`token`、`fencingToken`、`renew()`、`release()`、`assertOwner()`。

### tryLock(redis, key, options)

```typescript
const lock = await tryLock(redis, 'lock:job:daily-report', {
  ttl: 60_000,
  fencing: true,
})

if (!lock) return

try {
  await runJob(lock.fencingToken)
  await lock.renew()
} finally {
  await lock.release()
}
```

`tryLock()` returns `undefined` when the key is already locked.

### withLock(redis, key, options, fn)

```typescript
const result = await withLock(redis, 'lock:user:123', {
  ttl: 30_000,
  wait: 5_000,
  pollInterval: 20,
  maxPollInterval: 500,
  renew: true,
}, async ({ token, fencingToken }) => {
  return performWrite({ token, fencingToken })
})
```

`withLock()` releases the lock after the callback resolves or rejects. When the callback resolves, it first asserts that the caller still owns the lock. If ownership was lost, it throws `LockOwnershipLostError` instead of returning a stale success.

## Options

| Option | Required | Meaning |
|---|---:|---|
| `ttl` | yes | Lock lease duration in milliseconds. Must be longer than normal critical-section time. |
| `wait` | no | How long `withLock()` waits for a busy lock. Default `0`, which throws `LockConflictError` immediately. |
| `pollInterval` | no | Initial wait polling delay. Default `20` ms. |
| `maxPollInterval` | no | Maximum wait polling delay. Default `500` ms. |
| `renew` | no | `true` starts automatic renewal at `ttl / 2`; `{ interval }` chooses a custom interval. |
| `fencing` | no | `true` returns an increasing fencing token; `{ key }` customizes the Redis counter key. |
| `token` | no | Custom owner token for tests or advanced integrations. Defaults to `randomUUID()`. |

## Fencing Tokens

Locks alone cannot stop a slow old owner from writing to a resource after its lease expired. When a downstream store can compare a monotonically increasing token, enable fencing:

```typescript
await withLock(redis, 'lock:account:1', {
  ttl: 30_000,
  fencing: true,
}, async ({ fencingToken }) => {
  await accountRepo.updateIfNewer(accountId, changes, fencingToken)
})
```

The package generates fencing tokens with Redis `INCR`. The lock user must enforce the token in the protected resource.

## Error Types

| Error | When it happens |
|---|---|
| `LockConflictError` | The key is locked and `wait` is `0` or omitted. |
| `LockTimeoutError` | The key stayed locked longer than `wait`. |
| `LockOwnershipLostError` | The callback finished but the owner token was no longer present. |
| `LockRenewalError` | `renew()` failed because the caller no longer owns the lock. |

## Boundaries

This is a lease lock, not a transaction system. Always keep final consistency walls in the protected resource when the operation is irreversible: database constraints, compare-and-set writes, fencing-token checks, idempotency records, or outbox rows.

## Testing

```bash
pnpm --filter @hile/redis-lock test
pnpm --filter @hile/redis-lock build
```

## License

MIT
