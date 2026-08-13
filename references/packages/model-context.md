# Model And Context

Packages: `@hile/model`, `@hile/context`.

## Use When

Use `@hile/model` for reusable business logic and `@hile/context` for request/work-unit context that should flow through async calls, micro messages, and queue jobs.

## Do Not Use When

- Do not put business logic only in controllers when it will be reused by jobs, pages, or message handlers.
- Do not add fixed business fields to `@hile/context`; each app owns its context shape.

## Install

```bash
pnpm add @hile/model @hile/context
```

## Imports

```ts
import { defineActionModel, defineModel, loadModel } from '@hile/model'
import { contextHttp, contextModel, getContext, requireContext, runWithContext } from '@hile/context'
```

## Copy-Paste Example

```ts
import { defineModel } from '@hile/model'

export default defineModel(async (input: { name: string }) => {
  return { greeting: `Hello ${input.name}` }
})
```

Use it:

```ts
const result = await loadModel(greetModel, { name: 'Ada' })
```

Action adapters can discover a model explicitly without changing how it executes:

```ts
import { defineActionModel } from '@hile/model'

export default defineActionModel(async (input: { value: number }) => ({
  value: input.value + 1,
}))
```

`ModelActionRegistry` extends `@hile/loader.Loader`, scans domain-organized `*.model.*` files, and registers only action-marked models. `RscPluginService.load(modelsDirectory)` owns this lifecycle for RSC plugins.

## More Examples

```ts
import { defineModel } from '@hile/model'
import typeormService from '@hile/typeorm'

export const findUser = defineModel({
  services: [typeormService] as const,
  pipelines: [
    async (ctx, next) => {
      if (!ctx.args.userId) throw new Error('userId is required')
      await next()
    },
  ],
  async main([ds], input: { userId: string }) {
    return ds.getRepository(User).findOneBy({ id: input.userId })
  },
})
```

Context in HTTP:

```ts
http.use(contextHttp({
  read: (ctx) => ({ requestId: String(ctx.headers['x-request-id'] ?? crypto.randomUUID()) }),
  write: (context, ctx) => ctx.set('x-request-id', String(context.requestId ?? '')),
}))
```

Context in model pipeline:

```ts
const withTenant = contextModel<{ tenantId: string }>({
  read: (input) => ({ tenantId: input.tenantId }),
})
```

## Compose With

- `@hile/http` controllers should call `loadModel()`.
- `@hile/redis-idempotency` and `@hile/redis-rate-limit` provide model pipeline middleware.
- `@hile/micro` propagates context in message metadata.
- `@hile/redis-stream-queue` snapshots context when enqueuing and restores it in workers.

## Runtime And Lifecycle Notes

- `loadModel(model, input)` rejects if the first argument was not created by `defineModel()`.
- `defineActionModel()` returns a normal model definition plus an explicit action capability marker.
- Model input must be an object.
- Services are loaded in the order of the `services` tuple.
- Pipeline middleware follows Koa-style `await next()`.
- The terminal model result is stored in `ctx.state.result` and returned by `loadModel()`.
- `runWithContext()` merges with parent context by default; pass `{ merge: false }` to replace.
- `getContext()` returns a frozen shallow snapshot.
- `requireContext(keys)` throws when selected keys are missing.

## Anti-Patterns

- Passing primitives to `loadModel()`.
- Mutating context snapshots.
- Logging whole context objects by default.
- Assuming context propagation changes business payloads; it should stay in metadata or async storage.
- Exposing every scanned model as a browser action; only action-marked models may be mounted.

## Verification Checklist

- Models export `defineModel(...)` results.
- Browser-callable models explicitly use `defineActionModel(...)`.
- Controllers and pages call `loadModel(model, objectInput)`.
- Pipeline middleware writes derived state to `ctx.state`.
- Context keys are app-defined and JSON-serializable when crossing process boundaries.
