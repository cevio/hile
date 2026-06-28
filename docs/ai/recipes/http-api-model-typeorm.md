# HTTP API + Model + TypeORM

## Complete Example

Controller:

```ts
// src/controllers/users/[id].controller.ts
import { defineController } from '@hile/http'
import { loadModel } from '@hile/model'
import { getUser } from '../../models/users/get-user.model'

export default defineController('GET', async (ctx) => {
  return loadModel(getUser, { userId: String(ctx.params.id) })
})
```

Model:

```ts
// src/models/users/get-user.model.ts
import { defineModel } from '@hile/model'
import typeormService from '@hile/typeorm'
import { User } from '../../entities/user.entity'

export const getUser = defineModel({
  services: [typeormService] as const,
  async main([ds], input: { userId: string }) {
    const user = await ds.getRepository(User).findOneBy({ id: input.userId })
    if (!user) return { found: false }
    return { found: true, user }
  },
})
```

Boot file:

```ts
// src/services/http.boot.ts
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

Package config:

```json
{
  "type": "module",
  "scripts": {
    "dev": "hile start --dev --env-file .env",
    "start": "hile start --env-file .env.prod"
  },
  "hile": {
    "auto_load_packages": ["@hile/typeorm"]
  }
}
```

## File Layout

```text
src/
  controllers/users/[id].controller.ts
  entities/user.entity.ts
  models/users/get-user.model.ts
  services/http.boot.ts
```

## User Intent

Use this recipe when the user wants an HTTP endpoint backed by reusable business logic and a SQL database.

## Packages To Use

- `@hile/http`
- `@hile/model`
- `@hile/typeorm`
- `@hile/core`

## Implementation Steps

1. Put domain logic in a model file.
2. Inject TypeORM through `services: [typeormService] as const`.
3. Keep the controller thin and call `loadModel(model, objectInput)`.
4. Load controllers before `http.listen()`.
5. Register the close function with `shutdown()`.

## Failure And Cleanup Behavior

- TypeORM default service destroys the DataSource during container shutdown.
- Controller errors propagate through Koa.
- If writes are involved, wrap them in `transaction(ds, async (runner, rollback) => ...)`.

## Verification Checklist

- Controller returns `loadModel(...)`.
- Model input is an object.
- Boot file default-exports `defineService(...)`.
- `@hile/typeorm` is auto-loaded or explicitly loaded before use.
