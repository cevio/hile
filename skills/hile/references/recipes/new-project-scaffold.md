# New Project Scaffold

## Complete Example

```bash
npx create-hile create orders-api
cd orders-api
pnpm install
pnpm run dev
```

Default HTTP controller:

```ts
// src/controllers/index.controller.ts
import { defineController } from '@hile/http'

export default defineController('GET', async () => {
  return { ok: true }
})
```

Default HTTP boot:

```ts
// src/services/index.boot.ts
import { defineService } from '@hile/core'
import { Http } from '@hile/http'

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: Number(process.env.HTTP_PORT ?? 3000) })
  await http.load(new URL('../controllers', import.meta.url).pathname)
  const close = await http.listen()
  shutdown(close)
  return http
})
```

## File Layout

```text
orders-api/
  src/controllers/index.controller.ts
  src/services/index.boot.ts
  package.json
  .env
```

## User Intent

Use this recipe when the user wants a new Hile app or template guidance.

## Packages To Use

- `create-hile`
- Template-selected Hile packages

## Implementation Steps

1. Choose a template by app shape.
2. Make sure scripts use `hile start --dev` for development.
3. Keep boot files under `src/**`.
4. Add models when domain logic grows beyond a sample controller.

## Failure And Cleanup Behavior

- Generated apps rely on `@hile/cli` to find boot files and call container shutdown.
- Production needs build output under `dist`.

## Verification Checklist

- `package.json` has `"type": "module"`.
- `pnpm run dev` starts `hile start --dev`.
- Boot file registers server close function.
- Template README matches the selected template, not an unrelated app.
