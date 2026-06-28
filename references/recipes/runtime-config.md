# Runtime Dynamic Config

## Complete Example

```ts
import { z } from 'zod'
import { MicroDynamicConfigsServer } from '@hile/micro-dynamic-configs'

const schema = z.object({
  featureCheckout: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
})

const configs = new MicroDynamicConfigsServer({
  app,
  redis,
  schema,
  redis_key: 'configs:checkout',
})

const cleanup = await configs.initialize()
shutdown(cleanup)

configs.on('change:featureCheckout', (next, previous) => {
  logger.info({ previous, next }, 'featureCheckout changed')
})

await configs.save({ featureCheckout: true })
```

## File Layout

```text
src/services/configs.boot.ts
src/services/app.boot.ts
```

## User Intent

Use this recipe when config changes should persist to Redis and be pushed through the micro registry without restarting services.

## Packages To Use

- `@hile/micro-dynamic-configs`
- `@hile/micro`
- `@hile/ioredis`
- `zod`

## Implementation Steps

1. Define a Zod object schema with defaults.
2. Create `MicroDynamicConfigsServer`.
3. Call `initialize()` after `app` and `redis` are ready.
4. Register cleanup with `shutdown()`.
5. Use `.save(partial)` for changes.

## Failure And Cleanup Behavior

- `save()` validates fields before mutating memory.
- Redis is written before memory and event emission update.
- `initialize()` publishes every config field as a topic.
- Cleanup unpublishes topics and removes listeners.

## Verification Checklist

- Schema defaults parse `{}`.
- `redis_key` is app-specific.
- Change handlers use `change:key`.
- Cleanup from `initialize()` is registered.
