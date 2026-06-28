# Redis Cache With Singleflight

## Complete Example

```ts
import { loadService } from '@hile/core'
import redisService from '@hile/ioredis'
import { Cache, defineCache, RedisCache } from '@hile/cache'

const userProfileCache = defineCache(
  'user:{id:string}:profile',
  async ({ id }) => {
    const profile = await loadProfileFromDatabase(id)
    if (!profile) return new Cache(undefined)
    return new Cache(profile).setExpire(300)
  },
  {
    singleflight: { ttl: 10_000, wait: 10_000 },
    stale: { ttl: 60 },
    negative: { ttl: 30 },
    tags: (params, data) => data ? [`user:${params.id}`] : [],
  },
)

const redis = await loadService(redisService)
const cache = new RedisCache('app:', redis)
const userProfiles = await cache.loadCache(userProfileCache)

const profile = await userProfiles.read({ id: 'u1' })
await userProfiles.remove({ id: 'u1' })
await cache.removeTag('user:u1')
```

## File Layout

```text
src/
  caches/user-profile.cache.ts
  models/users/get-profile.model.ts
```

## User Intent

Use this recipe when reads are expensive and Redis should provide read-through caching with stampede protection.

## Packages To Use

- `@hile/cache`
- `@hile/ioredis`
- `@hile/redis-lock` indirectly through cache singleflight

## Implementation Steps

1. Define a typed key with placeholders.
2. Return `new Cache(value)` from the loader function.
3. Add TTL with `setExpire(seconds)`.
4. Enable `singleflight` for expensive reads.
5. Remove cache entries after writes.

## Failure And Cleanup Behavior

- Stale cache serves previous values while refresh runs.
- Negative cache stores missing values only when configured.
- Cache is not source of truth; database writes should remove or refresh related keys.

## Verification Checklist

- Cache handler returns `Cache`.
- Key params match placeholders.
- Redis prefix is app-specific.
- Update flows call `remove()` or `removeTag()`.
