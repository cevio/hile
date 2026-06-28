---
name: redis-rate-limit
description: Use when implementing Redis-backed rate limiting, fixed-window quotas, sliding-window quotas, token-bucket smoothing, HTTP 429 middleware, or Hile model rate-limit middleware.
---

# Redis Rate Limit

Use `@hile/redis-rate-limit` when an operation needs a shared quota across processes.

## Core Rule

Define a limit once, create a `RedisRateLimiter` around the Redis client, and call `consume()` at the boundary of the expensive or sensitive operation.

```typescript
const loginLimit = defineLimit('rl:login:{ip:string}', {
  algorithm: 'sliding-window',
  limit: 5,
  window: 60_000,
})

const result = await limiter.consume(loginLimit, { ip })
if (!result.allowed) throw new RateLimitExceededError(result)
```

## Design Boundaries

- Supported algorithms are `fixed-window`, `sliding-window`, and `token-bucket`.
- Fixed window uses a Redis integer counter with TTL. A consume after quota is exceeded still increments the counter, but does not extend the window.
- Sliding window uses a Redis sorted set of accepted hit timestamps. Rejected hits are not inserted.
- Token bucket uses a Redis hash with fractional `tokens` and `updatedAt`. `limit` is capacity; `window` is the time to refill from empty to full.
- Lua scripts perform mutation, checking, TTL, and retry metadata atomically.
- `dryRun` must never mutate Redis.
- Return `retryAfter` in milliseconds; HTTP `Retry-After` is seconds.
- Do not claim fairness or exactly-once behavior from rate limiting.

## Adapters

- Use `rateLimitHttp(limit, { limiter, key })` for `@hile/http`/Koa-compatible middleware. It sets rate-limit headers and returns 429 when exceeded.
- Use `rateLimitModel(limit, { limiter, key })` inside `@hile/model` pipelines. It stores the result in `ctx.state.rateLimit` and throws `RateLimitExceededError` when exceeded.
