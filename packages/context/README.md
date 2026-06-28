# @hile/context

Typed async context propagation primitives for Hile applications.

`@hile/context` does not define business fields. It stores whatever context shape the application declares and keeps that data isolated across async work. Adapters can seed context from HTTP, model pipelines, logger bindings, and `@hile/micro` calls without adding fields to business payloads.

## Install

```bash
pnpm add @hile/context
```

## Quick Start

```typescript
import { getContext, runWithContext } from '@hile/context'

type AppContext = {
  shopId: string
  memberId: string
  channel: 'web' | 'wechat'
}

await runWithContext<AppContext>({
  shopId: 'shop-1',
  memberId: 'member-1',
  channel: 'web',
}, async () => {
  const context = getContext<AppContext>()
  console.log(context.shopId)
})
```

Outside `runWithContext()`, `getContext()` returns an empty object.

## Core API

### runWithContext(context, callback, options?)

Runs `callback` inside an `AsyncLocalStorage` scope.

```typescript
await runWithContext<AppContext>({ shopId: 'shop-1' }, async () => {
  await doWork()
})
```

Nested calls merge with the parent context by default:

```typescript
await runWithContext<AppContext>({ shopId: 'shop-1', channel: 'web' }, async () => {
  await runWithContext<AppContext>({ channel: 'wechat' }, async () => {
    getContext<AppContext>() // { shopId: 'shop-1', channel: 'wechat' }
  })
})
```

Pass `{ merge: false }` to replace the parent context.

### getContext()

Returns a readonly shallow snapshot of the active context. Mutating the returned object does not mutate the store.

### snapshotContext()

Returns a readonly shallow snapshot for propagation. Cross-process transports should only put JSON-serializable values into context.

### requireContext(keys)

Asserts that selected application-defined keys are present.

```typescript
const context = requireContext<AppContext>(['shopId', 'channel'])
```

It throws `MissingContextError` when a selected key is missing.

## HTTP Adapter

`contextHttp()` is mapping-only. The package does not prescribe header names.

```typescript
import { contextHttp } from '@hile/context'

app.use(contextHttp<AppContext, Koa.Context>({
  read: ctx => ({
    shopId: ctx.get('x-shop'),
    channel: ctx.get('x-channel') as AppContext['channel'],
  }),
  write: (context, ctx) => {
    if (context.shopId) ctx.set('x-current-shop', context.shopId)
  },
}))
```

## Model Adapter

```typescript
import { contextModel, requireContextModel } from '@hile/context'
import { defineModel } from '@hile/model'

const model = defineModel({
  pipelines: [
    contextModel<{ store: string; source: 'web' | 'wechat' }, AppContext>({
      read: input => ({
        shopId: input.store,
        channel: input.source,
      }),
    }),
    requireContextModel<{ store: string; source: 'web' | 'wechat' }, AppContext>(['shopId']),
  ],
  async main(input) {
    return getContext<AppContext>()
  },
})
```

## Logger Binding

Logger bindings are opt-in. Without `pick` or `map`, no context fields are logged.

```typescript
import { withContextLogger } from '@hile/context'

const logger = withContextLogger<AppContext>(baseLogger, {
  pick: ['shopId', 'channel'],
})

logger.info({ event: 'checkout' }, 'checkout created')
```

## @hile/micro Propagation

When `@hile/micro` depends on `@hile/context`, calls made inside `runWithContext()` propagate the current context through message metadata:

```typescript
await runWithContext<AppContext>({ shopId: 'shop-1', channel: 'web' }, async () => {
  await app.call('inventory', '/reserve', { sku: 'sku-1' })
})
```

The receiving handler can call `getContext<AppContext>()`. The business `data` payload remains unchanged; context travels separately in `metadata.context`.

## Boundaries

- No field names are built into this package.
- Context is a request/work-unit scope, not a process-level configuration store.
- `getContext()` returns a shallow snapshot, not a deep clone.
- Cross-process propagation should use JSON-serializable values.
- Logger integration logs only fields selected by the application.

## Testing

```bash
pnpm --filter @hile/context test
pnpm --filter @hile/context build
```

## License

MIT
