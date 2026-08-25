# Micro RPC With Message Loader

## Complete Example

Provider handler:

```ts
// src/messages/charge.msg.ts
import { defineMicroMessage } from '@hile/micro'

export default defineMicroMessage(async ({ data, invocation }) => {
  return { charged: true, input: data, requestId: invocation.context.values.requestId }
})
```

Provider boot:

```ts
// src/services/app.boot.ts
import { defineService } from '@hile/core'
import { Application } from '@hile/micro'

export default defineService('billing.micro', async (shutdown) => {
  const app = new Application({
    namespace: 'billing',
    registry: { host: '127.0.0.1', port: 9876 },
    advertiseHost: '127.0.0.1',
  })

  await app.load(new URL('../messages', import.meta.url).pathname)
  const stop = await app.listen(9101)
  shutdown(stop)
  return app
})
```

Consumer:

```ts
import { randomUUID } from 'node:crypto'
import { createExecutionContext } from '@hile/context'

const context = createExecutionContext({ requestId: randomUUID(), tenantId: 't1' })
const result = await app.call('billing', '/charge', {
  tenantId: 't1',
  amount: 100,
}, { context })
```

## File Layout

```text
provider/
  src/messages/charge.msg.ts
  src/services/app.boot.ts
consumer/
  src/models/payments/pay.model.ts
```

## User Intent

Use this recipe when services communicate over Hile registry-backed RPC.

## Packages To Use

- `@hile/micro`
- `@hile/context` for the required explicit execution context carrier
- `@hile/redis-idempotency` for retryable side effects

## Implementation Steps

1. Start a Registry with `hile registry`.
2. Start providers with stable namespaces.
3. Default-export `defineMicroMessage()` handlers and load them through `app.load()`.
4. Create context at ingress and call providers with `await app.call(namespace, url, data, { context })`.
5. Use `app.stream()` only for async-generator handlers.

## Failure And Cleanup Behavior

- `Application.call()` may retry; side-effecting handlers need idempotency.
- Registry disconnect triggers reconnect; apps re-declare topics and subscriptions.
- Circuit breaker excludes failing nodes for cooldown.

## Verification Checklist

- Registry is reachable.
- Provider namespace matches consumer call.
- Handlers default-export `defineMicroMessage()` and consume explicit invocation context when needed.
- Consumer code awaits `app.call(..., { context })` directly.
