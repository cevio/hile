# Runtime Reactivity

Packages: `@hile/reactivity`.

## Copy-Paste Example

Reactive config topics feeding a reloadable runtime:

```ts
import { reactiveConfig, reactiveReloader, watchSerialLatest } from '@hile/reactivity'

type RuntimeConfig = {
  mysql: { host: string; port: number }
  redis: { host: string; port: number }
  flags: Record<string, boolean>
}

const configs = await reactiveConfig<RuntimeConfig>(app, {
  topics: {
    mysql: 'config:mysql',
    redis: 'config:redis',
    flags: 'config:flags',
  },
  required: ['mysql', 'redis'],
  defaults: { flags: {} },
})

const runtime = reactiveReloader<RuntimeConfig, Runtime>({
  debounceMs: 100,
  create: createRuntime,
  dispose: runtime => runtime.close(),
  onError: (error, context) => {
    logger.error({ error, stage: context.stage }, 'runtime reload failed')
  },
})

const stopReload = watchSerialLatest(configs.current, async config => {
  if (!config) return
  await runtime.update(config)
})

http.use(async (ctx, next) => {
  const handler = runtime.current.value
  if (!handler) {
    ctx.status = 503
    ctx.body = { error: 'runtime is not ready' }
    return
  }
  await handler.handle(ctx, next)
})

shutdown(async () => {
  stopReload()
  await configs.stop()
  await runtime.stop()
})
```

## More Examples

Subscribe to one topic as a readonly ref:

```ts
import { topicRef, watchLatest } from '@hile/reactivity'

const limit = await topicRef<number>(app, 'config:limit', { defaultValue: 10 })

watchLatest(limit.ref, async value => {
  logger.info({ value }, 'limit changed')
})

shutdown(limit.stop)
```

Publish a local ref as a topic with serial latest-wins updates:

```ts
import { publishRef, shallowRef } from '@hile/reactivity'

const limit = shallowRef(10)
const published = await publishRef(app, 'runtime:limit', limit)

limit.value = 20

shutdown(published.stop)
```

Choose an async watch strategy explicitly:

```ts
import { watchLatest, watchSerialLatest, watchQueue } from '@hile/reactivity'

watchLatest(searchText, async (value, { signal }) => {
  const result = await fetchResult(value, { signal })
  cache.value = result
})

watchSerialLatest(configRef, async config => {
  await reloader.update(config)
})

watchQueue(auditEventRef, async event => {
  await appendAuditLog(event)
})
```

## Use When

Use `@hile/reactivity` when Hile service code needs to compose micro topics, dynamic config, or runtime reloader state as refs instead of manual callback chains.

## Do Not Use When

- Do not use it to replace `@hile/micro`; it adapts `publish()` and `subscribe()` but does not change RPC or pub/sub semantics.
- Do not use it to replace `@hile/reloader`; use `reactiveReloader()` when callers need refs for `current`, `state`, and `error`.
- Do not use it as an event log. Refs model current state; use a queue for durable event processing.
- Do not use `watchLatest` for side effects that must all run. Use `watchQueue` for every-event handling.
- Do not rely on AbortSignal to kill non-cooperative async work. It prevents stale writes only when handlers respect the signal or check `isCurrent()`.

## Install

```bash
pnpm add @hile/reactivity
```

## Imports

```ts
import {
  topicRef,
  publishRef,
  reactiveConfig,
  reactiveReloader,
  watchLatest,
  watchSerialLatest,
  watchQueue,
  shallowRef,
  computed,
} from '@hile/reactivity'
```

## Compose With

- Use `@hile/micro` for the `Application` passed to `topicRef()`, `publishRef()`, and `reactiveConfig()`.
- Use `@hile/reloader` behavior through `reactiveReloader()` when runtime creation/disposal must stay singleflight and latest-wins.
- Use `@hile/micro-dynamic-configs` to persist config in Redis and publish config fields through micro topics.
- Use `@hile/http` or `@hile/http-next` with a stable listener that reads `runtime.current.value`.

## Runtime And Lifecycle Notes

- `topicRef()` subscribes once, stores the latest payload in a readonly ref, marks `ready` after the first payload, and unsubscribes on `stop()`.
- `publishRef()` publishes the initial ref value, then watches later changes with serial latest-wins updates. `stop()` drops pending values that have not started, waits for the active `publisher.update()` to settle, then calls `publisher.unpublish()`.
- `reactiveConfig()` uses `createConfigAggregator()` internally, so required keys, defaults, debounce, signatures, and listener error semantics stay aligned with `@hile/reloader`.
- `reactiveConfig().stop()` attempts every subscribed cleanup before reporting unsubscribe failures. Failed cleanup remains retryable, and `onError` can receive `stage: 'unsubscribe'`.
- `reactiveReloader()` wraps `createRuntimeReloader()` and exposes readonly refs for `current`, `state`, and `error`.
- `watchLatest()` aborts stale work and reports errors only for the latest non-aborted run.
- `watchSerialLatest()` never runs handlers concurrently and collapses pending changes to the latest value.
- `watchQueue()` never runs handlers concurrently and processes every observed value in order.
- `@vue/reactivity` is a peer dependency. Import refs and watch helpers from `@hile/reactivity`, or ensure the application resolves a single physical copy of `@vue/reactivity`.
- Register every returned `stop()` with Hile shutdown.

## Anti-Patterns

- Starting async work inside a raw `watch()` without choosing latest-wins, serial latest-wins, or queue semantics.
- Updating a micro topic directly from multiple uncoordinated watchers.
- Creating refs from a second physical copy of `@vue/reactivity`; cross-instance refs can be recognized as refs but not tracked by this package's watchers.
- Passing large mutable objects through deep reactive proxies. Prefer `shallowRef` for Hile runtime/config snapshots.
- Forgetting to stop topic subscriptions or publisher bindings during service shutdown.

## Verification Checklist

- Unit-test async watcher behavior with overlapping updates.
- Verify `topicRef().stop()` unsubscribes and later topic pushes do not mutate the ref.
- Verify `publishRef()` skips superseded pending values and calls `unpublish()` on stop.
- Verify `reactiveConfig()` does not emit until required topics are present.
- Verify `reactiveConfig()` preserves subscribe failures even when best-effort cleanup also fails, and that failed stop cleanup can be retried.
- Verify `reactiveReloader()` preserves `@hile/reloader` failure behavior and exposes current runtime after successful update.
