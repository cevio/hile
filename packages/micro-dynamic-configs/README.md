# @hile/micro-dynamic-configs

Dynamic configuration server for @hile/micro. Stores config in Redis, validates with Zod, and pushes changes to subscribers via micro's built-in pub/sub.

## Usage

```ts
import { Application } from '@hile/micro';
import { MicroDynamicConfigsServer } from '@hile/micro-dynamic-configs';
import Redis from 'ioredis';
import { z } from 'zod';

const schema = z.object({
  name: z.string().default(''),
  port: z.number().default(8080),
  debug: z.boolean().default(false),
});

const app = new Application({
  namespace: 'config-svc',
  registry: { host: '127.0.0.1', port: 6379 },
});

const redis = new Redis({ host: '127.0.0.1', port: 6379 });

const configs = new MicroDynamicConfigsServer({
  app,
  redis,
  schema,
  redis_key: 'my-app:config',
});

await configs.initialize();

// Read current value
console.log(configs.value); // { name: '', port: 8080, debug: false }

// Update and persist — subscribers receive push
await configs.save({ name: 'production', port: 9090 });
```

## Topic Convention

Each schema field publishes to a separate topic:

```
{namespace}:{field}
```

For example, with namespace `config-svc` and schema fields `name`, `port`, `debug`:

- `config-svc:name`
- `config-svc:port`
- `config-svc:debug`

## Subscribing

Use `app.subscribe()` directly on any micro Application:

```ts
const values: Record<string, any> = {};
const unsub = await app.subscribe('config-svc:name', (v) => values.name = v);
```

## Local Events

The server emits `change:{field}` events locally:

```ts
configs.on('change:name', (newValue, oldValue) => {
  console.log(`name changed from ${oldValue} to ${newValue}`);
});
```

## Persistence

Config is persisted to Redis on every `save()`. On `initialize()`, the server loads the last saved state from Redis. Schema defaults apply when no value exists.

## Teardown

```ts
const teardown = await configs.initialize();
// Later:
await teardown(); // unpublishes all topics and cleans up listeners
```
