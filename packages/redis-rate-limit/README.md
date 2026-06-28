# @hile/redis-rate-limit

Redis-backed rate limiting primitives and Hile adapters. Supports fixed window, sliding window, and token bucket algorithms.

Use this package for login attempts, SMS/email sending, tenant quotas, expensive endpoints, and other operations that need a shared limit across processes.

## Install

```bash
pnpm add @hile/redis-rate-limit
```

The package accepts any Redis client matching `RedisRateLimitLike`. In Hile apps the usual client comes from `@hile/ioredis`.

## Quick Start

```typescript
import { RateLimitExceededError, RedisRateLimiter, defineLimit } from '@hile/redis-rate-limit'

const loginLimit = defineLimit('rl:login:{ip:string}', {
  algorithm: 'sliding-window',
  limit: 5,
  window: 60_000,
})

const limiter = new RedisRateLimiter(redis, { prefix: 'myapp:' })
const result = await limiter.consume(loginLimit, { ip: ctx.ip })

if (!result.allowed) {
  throw new RateLimitExceededError(result)
}
```

## Algorithms

All algorithms use the same public shape:

```typescript
defineLimit(key, {
  algorithm: 'fixed-window' | 'sliding-window' | 'token-bucket',
  limit: 5,
  window: 60_000,
})
```

For `fixed-window` and `sliding-window`, `limit` is the maximum allowed requests per `window` milliseconds.

For `token-bucket`, `limit` is the bucket capacity. The bucket refills from empty to full over `window` milliseconds, so `limit: 4, window: 4000` refills at one token per second. Each `consume()` costs one token.

## State Machines

### Fixed Window

For each resolved Redis key:

| State | Redis shape | Meaning |
|---|---|---|
| `empty` | no key | No request has started the current window. |
| `active` | integer counter with `PX window` | Requests are counted in the current fixed window. |
| `exceeded` | integer counter with same TTL | Requests continue to increment, but `allowed` is `false`. |
| `reset` | key expired | The next consume starts a fresh window. |

The first non-dry-run consume creates the key with the configured TTL. Later consumes increment the counter with Lua and do not extend the TTL. `dryRun` returns what would happen for the next consume without writing or incrementing Redis.

`retryAfter` is milliseconds until the current window resets. HTTP `Retry-After` is emitted in seconds.

### Sliding Window

For each resolved Redis key:

| State | Redis shape | Meaning |
|---|---|---|
| `empty` | no key | No accepted hit is inside the rolling window. |
| `active` | sorted set of accepted hit timestamps | Accepted hits are counted if their score is inside `(now - window, +inf)`. |
| `exceeded` | same sorted set | The request is rejected; rejected hits are not inserted. |
| `reset` | key expired or old scores pruned | Old hits leave the rolling window individually. |

The Lua script prunes expired scores, counts the remaining hits, inserts the new hit only when allowed, and refreshes the key TTL to keep the sorted set alive until the last accepted hit expires. `retryAfter` points to the earliest accepted hit leaving the window.

### Token Bucket

For each resolved Redis key:

| State | Redis shape | Meaning |
|---|---|---|
| `full` | no key or full token count | A new key starts with `limit` tokens. |
| `partial` | hash with `tokens` and `updatedAt` | Tokens refill continuously based on elapsed milliseconds. |
| `empty` | hash with less than one token | The request is rejected until enough refill accrues. |
| `reset` | key expired | The bucket is considered full again. |

The script refills tokens from elapsed time, consumes one token when available, and stores fractional tokens. When the caller-provided clock moves backwards, the stored refill clock does not move backwards, so tokens cannot refill early. `retryAfter` points to the next token becoming available; `resetAt` points to full refill after an allowed consume and next token availability after a rejected consume.

## API

### defineLimit(key, options)

```typescript
const smsLimit = defineLimit('rl:sms:{phone:string}', {
  algorithm: 'token-bucket',
  limit: 3,
  window: 10 * 60_000,
})
```

`key` supports typed placeholders: `{id:string}`, `{n:number}`, `{flag:boolean}`.

### RedisRateLimiter

```typescript
const limiter = new RedisRateLimiter(redis, {
  prefix: 'billing:',
  dryRun: false,
})

const result = await limiter.consume(smsLimit, { phone }, {
  dryRun: false,
})
```

Result shape:

```typescript
{
  allowed: boolean,
  algorithm: 'fixed-window',
  key: string,
  limit: number,
  remaining: number,
  resetAt: number,
  retryAfter: number,
  dryRun: boolean,
}
```

### HTTP Adapter

```typescript
http.use(rateLimitHttp(loginLimit, {
  limiter,
  key: ctx => ({ ip: ctx.ip }),
}))
```

The middleware sets `X-RateLimit-*` and `RateLimit-*` headers. When exceeded, it returns status `429`, sets `Retry-After`, and does not call `next()`.

### Model Adapter

```typescript
pipeline.use(rateLimitModel(tenantLimit, {
  limiter,
  key: input => ({ tenantId: input.tenantId }),
}))
```

The middleware stores the result in `ctx.state.rateLimit`. When exceeded, it throws `RateLimitExceededError`.

## Boundaries

- Fixed window can allow bursts around a window boundary. Use sliding window or token bucket when that burst profile is unacceptable.
- Sliding window avoids fixed-window boundary bursts, but stores accepted hit timestamps in a Redis sorted set.
- Token bucket smooths traffic and allows bursts up to the bucket capacity.
- This package limits attempts; it does not authenticate users, dedupe side effects, or provide fairness across multiple keys.
- `resetAt` and `retryAfter` are calculated from the caller-provided clock and Redis state. Keep app clocks reasonably synchronized when exposing them to clients.

## Testing

```bash
pnpm --filter @hile/redis-rate-limit test
pnpm --filter @hile/redis-rate-limit build
```

## License

MIT
