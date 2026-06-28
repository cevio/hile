---
name: context
description: Use when implementing typed async context propagation, request/work-unit context, HTTP context mapping, model pipeline context, logger context bindings, or @hile/micro context propagation.
---

# Context

Use `@hile/context` when a Hile app needs request/work-unit data to flow through async code and microservice calls without passing it through every function argument.

## Core Rule

Never bake business fields into the package. The library owns storage and propagation only; applications own the context shape.

```typescript
type AppContext = {
  shopId: string
  channel: 'web' | 'wechat'
}

await runWithContext<AppContext>({ shopId, channel }, async () => {
  await doWork()
})
```

## Design Boundaries

- Core storage is an `AsyncLocalStorage<Record<string, unknown>>`.
- `getContext()` and `snapshotContext()` return readonly shallow snapshots.
- Nested `runWithContext()` calls merge by default; pass `{ merge: false }` to replace.
- `requireContext(keys)` validates only keys selected by the application.
- Do not add fixed fields like organization, user, or request dimensions to core types.
- Cross-process propagation should use JSON-serializable context values.

## Adapters

- Use `contextHttp({ read, write })` to map arbitrary HTTP request/response details to and from context. The package must not prescribe header names.
- Use `contextModel({ read })` inside `@hile/model` pipelines to seed context from model input.
- Use `requireContextModel(keys)` to enforce selected application-owned keys inside model pipelines.
- Use `withContextLogger(logger, { pick })` or `{ map }` to opt into logger bindings. Never log the whole context by default.
- `@hile/micro` propagates context in `metadata.context`; business payloads remain unchanged.
