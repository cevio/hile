# Stable Runtime Reload

## Complete Example

```ts
import { defineService, loadService } from '@hile/core'
import { Application } from '@hile/micro'
import { Http } from '@hile/http'
import { createConfigAggregator, createRuntimeReloader } from '@hile/reloader'
import appService from './micro.app.boot'
import httpService from './http.boot'

type RuntimeConfig = {
  mysql: { host: string; port: number }
  redis: { host: string; port: number }
  flags: Record<string, boolean>
}

export default defineService('runtime.reload', async (shutdown) => {
  const app = await loadService<Application>(appService)
  const http = await loadService<Http>(httpService)

  const reloader = createRuntimeReloader<RuntimeConfig, AppRuntime>({
    debounceMs: 100,
    normalize: config => ({
      mysql: config.mysql,
      redis: config.redis,
      flags: config.flags,
    }),
    create: config => createAppRuntime(config),
    dispose: runtime => runtime.close(),
    onError: (error, context) => {
      logger.error({ error, stage: context.stage }, 'runtime reload failed')
    },
  })

  const configs = createConfigAggregator<RuntimeConfig>({
    required: ['mysql', 'redis'],
    defaults: { flags: {} },
    debounceMs: 100,
    onError: (error) => {
      logger.error({ error }, 'runtime config emit failed')
    },
  })

  configs.onChange(config => reloader.update(config))

  const cleanupMysql = await app.subscribe('config:mysql', value => configs.set('mysql', value))
  const cleanupRedis = await app.subscribe('config:redis', value => configs.set('redis', value))
  const cleanupFlags = await app.subscribe('config:flags', value => configs.set('flags', value))

  http.use(async (ctx, next) => {
    const runtime = reloader.current()
    if (!runtime) {
      ctx.status = 503
      ctx.body = { error: 'runtime is not ready' }
      return
    }
    await runtime.handle(ctx, next)
  })

  shutdown(async () => {
    await cleanupMysql()
    await cleanupRedis()
    await cleanupFlags()
    configs.dispose()
    await reloader.stop()
  })

  return reloader
})
```

## File Layout

```text
src/services/runtime.reload.boot.ts
src/services/micro.app.boot.ts
src/services/http.boot.ts
```

## User Intent

Use this recipe when `app.subscribe()` receives config updates that should rebuild business runtime state without thrashing services or rebinding ports.

## Packages To Use

- `@hile/reloader`
- `@hile/micro`
- `@hile/http`
- `@hile/core`

## Implementation Steps

1. Keep the HTTP listener outside the reloader.
2. Create `RuntimeReloader` for the runtime object that can be safely swapped.
3. Create `ConfigAggregator` for all required subscribe topics.
4. Feed each `app.subscribe()` callback into `configs.set(key, value)`.
5. Use `configs.onChange(config => reloader.update(config))`.
6. Register subscribe cleanup, `configs.dispose()`, and `reloader.stop()` with shutdown.

## Failure And Cleanup Behavior

- Config bursts collapse through aggregator debounce and reloader debounce.
- Reloads never run concurrently.
- If `create()` fails, the previous runtime stays active.
- Old runtime disposal happens after the new runtime becomes current.
- Same-port HTTP services are not restarted.

## Verification Checklist

- Required config keys are received before the first runtime is created.
- Repeated equivalent configs do not reload.
- A failed create logs an error and leaves old traffic handling intact.
- The HTTP server is started once and reads `reloader.current()` per request.
