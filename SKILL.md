---
name: hile
description: "Code generation guide for the Hile monorepo (@hile/* packages). Covers service container, HTTP APIs, database (TypeORM), Redis, logging, job scheduling, message communication, microservices, model pipeline, and project scaffolding. Use this skill when generating or editing code that depends on @hile/core, @hile/logger, @hile/schedule, @hile/http, @hile/typeorm, @hile/ioredis, @hile/cache, @hile/micro, @hile/model, @hile/message-*, or create-hile."
---

# Hile — Unified Code Generation Guide

This document is a **code generation reference**, not an abstract design doc. When writing or modifying code that uses `@hile/*` packages, find your scenario below and follow the examples directly.

---

## Core Concepts (Universal)

**Service Container (`@hile/core`)** is the foundation:

- `defineService(key, fn)` — Register a service (does not execute)
- `loadService(service)` — Get a service instance (executes fn on first call, caches afterwards)
- `shutdown(fn)` — Register a cleanup callback inside the service function (LIFO order)

**Boot mechanism (`@hile/cli`)** :

- `src/services/*.boot.ts` — **Auto-scanned** by `hile start` at startup
- `src/services/*.service.ts` — **Lazy-loaded** services, loaded via `loadService` inside boot files / other services / models
- `package.json` `hile.auto_load_packages` — Module names (not file paths) to auto-load before boot scanning

---

## 1. Package Quick Reference

| What you need | Package | Key exports |
|--------------|---------|-------------|
| Async singleton service, lifecycle management | `@hile/core` | `defineService` / `loadService` / `isService` / `container` |
| Start app, scan boot files | `@hile/cli` | CLI `hile start` |
| HTTP API (Koa + routing) | `@hile/http` | `Http` / `defineController` / `Loader` / `defineResponsePlugin` |
| API + Next.js same port | `@hile/http-next` | `HttpNext` |
| Database operations | `@hile/typeorm` | `transaction` / default export DataSource service |
| Redis cache | `@hile/ioredis` | default export Redis client service |
| Templated Redis cache keys | `@hile/cache` | `defineCache` / `RedisCache` |
| Request/response message abstraction | `@hile/message-modem` | `MessageModem` (abstract, implement post/exec) |
| Parent-child process IPC | `@hile/message-ipc` | `MessageIpc` (abstract) |
| Worker thread communication | `@hile/message-worker-thread` | `MessageWorkerThread` (abstract) |
| WebSocket communication | `@hile/message-ws` | `MessageWs` (abstract) |
| File-system message routing | `@hile/message-loader` | `MessageLoader` / `defineMessage` |
| Microservice registry & discovery | `@hile/micro` | `Server` / `Client` / `Registry` / `Application` |
| Dynamic config (ZK-like) | `@hile/micro-dynamic-configs` | `MicroDynamicConfigsServer` |
| Business data pipeline (middleware chain) | `@hile/model` | `defineModel` / `loadModel` / `Pipeline` |
| Structured logging (pino) | `@hile/logger` | `createLogger` |
| Declarative job scheduling | `@hile/schedule` | `Scheduler` / `defineJob` |
| Scaffold new Hile project | `create-hile` | CLI `create-hile create <name>` |

---

## 2. @hile/logger — Structured Logging

```typescript
import { createLogger } from '@hile/logger';

const logger = createLogger();
logger.info('hello');
logger.error({ err }, 'something went wrong');
```

### Options

```typescript
createLogger({
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  pretty?: boolean      // default: !production
  redact?: string[]     // sensitive field paths, e.g. ['password', 'req.headers.authorization']
})
```

- **level** — 日志级别，默认 `LOG_LEVEL` 环境变量，未设置时 `'info'`
- **pretty** — 开发环境默认启用 `pino-pretty` 美化输出，生产环境输出 JSON
- **redact** — 敏感字段过滤

### Child logger

```typescript
const child = logger.child({ module: 'payment' });
child.info('processing'); // { "module": "payment", "msg": "processing" }
```

### Env variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `'info'` | Default log level |
| `NODE_ENV` | — | Controls `pretty` default |

---

## 3. @hile/schedule — Job Scheduling

```typescript
import { Scheduler, defineJob } from '@hile/schedule';

const scheduler = new Scheduler();

// Cron expression
scheduler.add('daily-report', '0 8 * * *', () => {
  console.log('daily report');
});

// Delay (ms)
scheduler.add('delayed-task', { delay: 5000 }, () => {
  console.log('after 5 seconds');
});

scheduler.stop(); // cancel all jobs
```

### Auto-load from directory

Create `{name}.schedule.ts` files:

```typescript
// tasks/daily-report.schedule.ts
import { defineJob } from '@hile/schedule';
export default defineJob('0 8 * * *', () => {
  console.log('daily report generated');
});
```

Load them:

```typescript
const scheduler = new Scheduler();
const off = await scheduler.load(resolve(__dirname, 'tasks')); // returns unregister function
// off() to unregister all
```

Custom suffix:

```typescript
await scheduler.load('./jobs', { suffix: 'job' }); // loads *.job.ts, *.job.js, ...
```

### API

- `defineJob(expression, handler)` — Returns `{ id: number, type: 'job', expression, handler }`
- `scheduler.add(id, expression | { delay }, handler)` — 注册任务，重复 id 抛异常
- `scheduler.remove(id)` — 取消任务
- `scheduler.stop()` — 取消所有任务
- `scheduler.getJobs(): JobInfo[]` — 返回已注册任务列表
- `scheduler.load(directory, options?)` — 自动发现并注册任务文件

---

## 4. @hile/core — Service Container

### Define and load a service

```typescript
// src/services/redis.service.ts — lazy-loaded service
import { defineService, loadService } from '@hile/core';

export default defineService('my-redis', async (shutdown) => {
  const client = new Redis(/* ... */);
  await client.connect();

  // Register cleanup immediately after creating external resources
  shutdown(() => client.disconnect());

  return client;
});
```

```typescript
// src/services/http.boot.ts — auto-start entry (scanned by CLI)
import { defineService, loadService } from '@hile/core';
import { Http } from '@hile/http';
import httpService from './http.service.js';

export default defineService('my-http', async (shutdown) => {
  const http = new Http({ port: 3000 });
  http.get('/hello', async (ctx) => { ctx.body = 'world'; });
  const close = await http.listen();
  shutdown(() => close());
});
```

### Access other services from within a service

```typescript
// Never use loadService at the module top level
export default defineService('worker', async (shutdown) => {
  // Always call loadService inside the service function
  const ds = await loadService(typeormService);
  const redis = await loadService(redisService);
  // ...
});
```

### Lifecycle reference

| Phase | Status | Description |
|-------|--------|-------------|
| Registration | — | `defineService` only registers, does not execute |
| First `loadService` | `init -> ready` | Runs factory function, caches result for subsequent calls |
| Startup failure | `init -> stopping -> stopped` | Runs registered shutdown callbacks, then clears queue |
| `container.shutdown()` | Reverse LIFO | Later-starting services shut down first; loops until queue is empty |

---

## 5. @hile/http — HTTP API

### Define a controller

```typescript
// src/controllers/user.controller.ts
// export default a single defineController or an array
import { defineController } from '@hile/http';

// Simple form: method + handler
export default defineController('GET', async (ctx) => {
  return { list: [] };
});

// With middleware
export default defineController('POST', [authMiddleware], async (ctx) => {
  return { success: true };
});

// With Zod validation
import { z, createControllerMetadata, defineController } from '@hile/http';

export default defineController(
  createControllerMetadata({
    method: 'POST',
    schema: {
      body: z.object({ name: z.string(), age: z.number() }),
    },
  }),
  async (ctx) => {
    // ctx.request.body is already Zod-validated
    return { result: ctx.request.body.name };
  },
);

// File path to route mapping:
//   src/controllers/user.controller.ts        → GET /user
//   src/controllers/user/index.controller.ts  → GET /user
//   src/controllers/user/[id].controller.ts   → GET /user/:id
```

### Create and start an HTTP service (in boot file)

```typescript
// src/services/http.boot.ts
import { defineService } from '@hile/core';
import { Http } from '@hile/http';

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: 3000 });

  http.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    console.log(`${ctx.method} ${ctx.url} ${Date.now() - start}ms`);
  });

  // Load all controller files from directory
  // Default suffix 'controller', conflict strategy 'error'
  await http.load('./src/controllers', { suffix: 'controller', defaultSuffix: '/index' });

  const close = await http.listen();
  shutdown(() => close());
});
```

### Response plugins

```typescript
import { defineResponsePlugin } from '@hile/http';

defineResponsePlugin(async (ctx, result, next) => {
  // Post-process all response results
  const processed = result !== undefined ? { code: 0, data: result } : undefined;
  return next(processed);
});
```

### Route conflict strategies

`Loader` supports three conflict strategies:
- `'error'` (default) — Throw on duplicate routes
- `'warn'` — Log a warning, keep existing route
- `'override'` — Unregister old route, register new one

---

## 6. @hile/http-next — HTTP + Next.js on the Same Port

### Standard project directory structure

```
project/
├── src/
│   ├── app/               # Next.js App Router pages
│   │   ├── page.tsx
│   │   └── ...
│   ├── controllers/       # API controllers (default prefix /-)
│   │   └── user.controller.ts    →  GET /-/user
│   ├── models/            # Business logic (defineModel only here)
│   │   ├── user/
│   │   │   └── user.model.ts
│   │   └── ...
│   └── services/          # Infrastructure services
│       ├── http.boot.ts   # HttpNext entry point
│       └── ...
├── next.config.ts
└── package.json
```

### HttpNext boot template

```typescript
// src/services/http.boot.ts
import { defineService } from '@hile/core';
import { HttpNext } from '@hile/http-next';

export default defineService('http', async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, '../..'),  // Important: boot is in services/, one extra level
  });

  const stop = await httpNext.start();
  shutdown(() => stop());
});
```

### Request processing order (static → API → Next)

```
HTTP Request
  → Koa middleware chain
  → koa-static (`public/` directory)
  → @hile/http routes (default prefix /-)
  → Next.js request handler (page rendering)
```

### Model layer rules (important)

```typescript
// src/models/user/user.model.ts
// defineModel can only be used under src/models/
import { defineModel } from '@hile/model';

export default defineModel(async (userId: string) => {
  return { id: userId, name: 'Alice' };
});

// src/app/user/page.tsx usage
import { loadModel } from '@hile/model';
import userModel from '@/models/user/user.model';

// When page.tsx uses loadModel, it must export dynamic
export const dynamic = 'force-dynamic';

export default async function UserPage() {
  const user = await loadModel(userModel, '1');
  return <div>{user.name}</div>;
}
```

---

## 7. @hile/typeorm — Database

### Setup

```json
// package.json
{
  "hile": {
    "auto_load_packages": ["@hile/typeorm"]
  }
}
```

Environment variables: `TYPEORM_TYPE` / `TYPEORM_HOST` / `TYPEORM_USERNAME` / `TYPEORM_PASSWORD` / `TYPEORM_DATABASE` / `TYPEORM_PORT` / `TYPEORM_ENTITIES` / `TYPEORM_SYNCHRONIZE`

### Usage inside a service

```typescript
import { loadService } from '@hile/core';
import typeormService from '@hile/typeorm';

const ds = await loadService(typeormService);
```

### Transaction with compensating callbacks

```typescript
import { transaction } from '@hile/typeorm';

await transaction(ds, async (runner, rollback) => {
  const user = await runner.manager.save(User, { name: 'Alice' });

  // Register compensation: executed LIFO on transaction failure
  rollback(async () => {
    // e.g., clear cache, send rollback notification
    await cache.del(`user:${user.id}`);
  });

  await runner.manager.save(Log, { action: 'create_user', userId: user.id });
  return user;
});
// Success → commitTransaction; Failure → rollbackTransaction + run compensation queue
```

---

## 8. @hile/ioredis — Redis

```json
// package.json
{
  "hile": {
    "auto_load_packages": ["@hile/ioredis"]
  }
}
```

Environment variables: `REDIS_HOST` / `REDIS_PORT` / `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_DB`

```typescript
import { loadService } from '@hile/core';
import redisService from '@hile/ioredis';

const redis = await loadService(redisService);
await redis.set('key', 'value');
await redis.get('key');
```

---

## 9. @hile/cache — Cache Key Declaration

```typescript
import { defineCache, RedisCache } from '@hile/cache';

// Declare a cache key with typed parameters
const userCache = defineCache('user:{id:string}:{x:number}', async (params) => {
  // params.id: string, params.x: number
  const data = await fetchUser(params.id);
  return new Cache(data).setExpire(60); // TTL 60 seconds
});

// Usage
const cache = new RedisCache('my-prefix:');
const { read, write, remove, has } = await cache.loadCache(userCache);

await read({ id: 'abc', x: 42 });     // Read (cache-through on miss)
await write({ id: 'abc', x: 42 });    // Write
await remove({ id: 'abc', x: 42 });   // Delete
await has({ id: 'abc', x: 42 });      // Check existence
```

---

## 10. Message Communication Architecture

### Layer hierarchy

```
@hile/message-modem (abstract base: request/response/abort/stream)
  ├── @hile/message-ipc (parent-child process)
  ├── @hile/message-worker-thread (Worker threads)
  └── @hile/message-ws (WebSocket)
        └── @hile/message-loader (file-system routing)
              └── @hile/micro (service discovery)
```

### MessageModem — implement a custom transport

```typescript
import { MessageModem, MessageTransferFormat } from '@hile/message-modem';

class MyModem extends MessageModem {
  protected post(data: MessageTransferFormat): void {
    // How to send data to the remote end
    transport.send(JSON.stringify(data));
  }
  protected async exec(data: any, signal?: AbortSignal): Promise<any> {
    // How to handle received requests; streaming must return AsyncIterable
    return processData(data);
  }
}

const modem = new MyModem();
// Bidirectional request: returns Promise<response>
const res = await modem._send({ url: '/hello', data: 'world' });
// With timeout and abort signal
const res2 = await modem._send({ url: '/slow' }, { timeout: 5000, signal: abortSignal });

modem._push({ url: '/log', data: 'info' });                    // One-way push
modem._push({ url: '/log', data: 'info' }, { timeout: 1000 }); // Push with timeout

const stream = modem._stream({ url: '/events' });              // Stream (returns Readable)
for await (const chunk of stream) {
  console.log('chunk:', chunk);
}
```

### MessageLoader — file-system message routing

```typescript
// src/messages/ping.msg.ts —— normal request-response
import { defineMessage } from '@hile/message-loader';
export default defineMessage(async ({ params, data }) => {
  return { type: 'pong', timestamp: Date.now() };
});

// src/messages/events.msg.ts —— streaming response (async function* returns AsyncIterable)
export default defineMessage(async function* ({ params, data }) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100));
    yield { value: data.query, index: i };  // seq is auto-generated by MessageModem
  }
});

// Route mapping: src/messages/ping.msg.ts → /ping, events.msg.ts → /events

// Load and dispatch
import { MessageLoader } from '@hile/message-loader';
const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' });
const unload = await loader.load('./src/messages'); // Returns an unload function

// Normal call
const result = await loader.dispatch('/-/ping', { /* data */ });

// Streaming call: dispatch returns AsyncIterable
const stream = await loader.dispatch('/-/events', { query: 'test' });
for await (const chunk of stream) {
  console.log('chunk:', chunk);
}
```

---

## 11. @hile/micro — Microservices

### Registry

```typescript
import { Registry } from '@hile/micro';
const registry = new Registry();
await registry.listen(9876);  // Start WebSocket registry
```

### Application (service provider + consumer)

The recommended approach on the provider side is **file-system routing**: place message handlers in `*.msg.ts` files and load them via `app.load()`:

```typescript
// src/messages/hello.msg.ts —— message handler file
import { defineMessage } from '@hile/message-loader';
export default defineMessage(async ({ params, data }) => {
  return `hello ${data.name}`;
});
// File path → route: src/messages/hello.msg.ts → /hello

// src/messages/events.msg.ts —— streaming message handler
export default defineMessage(async function* ({ params, data }) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    yield { value: data.type, index: i };  // seq is auto-generated by MessageModem
  }
});
// File path → route: src/messages/events.msg.ts → /events (paired with app.stream)
```

```typescript
// src/services/app.boot.ts —— entry point
import { Application } from '@hile/micro';
import { resolve } from 'node:path';

const app = new Application({
  namespace: 'my-service',
  registry: { host: '127.0.0.1', port: 9876 },
});

// Load all message handlers from the filesystem (recommended)
await app.load(resolve(__dirname, '../messages'));

// Call another service (consumer side)
const result = await app.call('other-service', '/hello', { name: 'world' });

// With timeout and retry options
const result2 = await app.call('other-service', '/slow', { data: 1 }, {
  timeout: 5000,       // Timeout, inherits Application's requestTimeoutMs by default
  retries: 0,          // Retry count, default 1
  signal: abortSignal, // Cancellable
});

// Streaming: for large result sets or SSE (returns Node.js Readable stream, works with for await...of)
const stream = await app.stream('other-service', '/events', { type: 'user-updates' });
for await (const chunk of stream) {
  console.log('received:', chunk);
}
// stream also supports options: { retries?, signal? }
const stream2 = await app.stream('other-service', '/events', { type: 'test' }, { retries: 2 });

// Pub/Sub — cross-service event broadcasting
// All service instances under the same registry + namespace receive subscribed events
// publish does not wait for subscribers to finish
const event = await app.publish('order.created', { orderId: 1, amount: 99 });

// event.update(data) — push an update (same event name, new data)
await event.update({ orderId: 1, amount: 199 });

// event.unpublish() — retire the event; subsequent subscribers will no longer receive it
await event.unpublish();

// subscribe returns an unsubscribe function
const unsubscribe = app.subscribe('order.created', (data) => {
  console.log('order created:', data.orderId, data.amount);
});
// Call unsubscribe() to stop listening
unsubscribe();

await app.listen(3001);
```

If programmatic registration is needed, `app.register(path, fn)` is also available (returns an unsubscribe function), but `app.load()` is preferred for better directory organization and route separation.

### Circuit breaker and retry

`Application.call()` and `Application.stream()` have built-in:
- **Circuit breaker**: Nodes that fail consecutively are excluded for a 30-second cooldown
- **Auto retry**: 1 retry by default, tries other nodes on failure
- **Cache degradation**: When the Registry is unavailable, uses the last successful node cache

---

## 12. @hile/model — Business Pipeline

```typescript
import { defineModel, loadModel, Pipeline } from '@hile/model';
import typeormService from '@hile/typeorm';
import redisService from '@hile/ioredis';

// Full form: services + pipelines + main
export default defineModel({
  services: [typeormService, redisService], // Auto-resolved
  pipelines: [async (ctx, next) => {
    console.log('before:', ctx.args);
    await next();
    console.log('after');
  }],
  main: async ([ds, redis], input: { id: string }) => {
    const user = await ds.manager.findOne(User, { where: { id: input.id } });
    return user;
  },
});

// Consumption: each loadModel re-executes main
const result = await loadModel(userModel, { id: '1' });

// Shorthand (no services / pipelines)
export default defineModel(async (input: { id: string }) => {
  return { id: input.id };
});
```

---

## 13. create-hile — Scaffolding

```bash
npx create-hile create my-project
# Choose a template: default / next / micro-http / micro / micro-http-next / monorepo
cd my-project && pnpm install && pnpm run dev
```

Templates:
- `default` — Plain HTTP (Koa + @hile/http)
- `next` — Next.js + @hile/http-next
- `micro-http` — Microservice + HTTP (no Next)
- `micro` — Pure microservice
- `micro-http-next` — Next.js + microservice + HTTP (full-stack)
- `monorepo` — Lerna + pnpm workspace

---

## 14. Common Anti-Patterns (Forbidden)

```typescript
// ❌ Top-level await loadService
import service from './service.js';
const instance = await loadService(service); // Forbidden

// ❌ Boot file exports a plain function
export default async () => { ... }; // Forbidden: must return defineService result

// ❌ Controller writes ctx.body AND returns
export default defineController('GET', async (ctx) => {
  ctx.body = { x: 1 }; // Forbidden: only return
  return { x: 1 };
});

// ❌ Controller signature is (ctx, next)
export default defineController('GET', async (ctx, next) => { // Forbidden
  await next();
});

// ❌ Boot file outside src/services/
// src/index.boot.ts  →  Forbidden

// ❌ auto_load_packages uses file paths
{ "hile": { "auto_load_packages": ["./src/services/db.service.ts"] } }  // Forbidden: must be module name

// ❌ Using loadService inside src/app/ (http-next)
// Forbidden: src/app/ only allows loadModel

// ❌ Defining model inside src/app/ (http-next)
// Forbidden: defineModel only works in src/models/

// ❌ Putting infrastructure in src/models/ or business logic in src/services/
```

---

## 15. Quick Reference: What API to Use in Which File

| File | Allowed imports |
|------|----------------|
| `src/services/*.boot.ts` | `defineService`, `loadService`, `loadModel` |
| `src/services/*.service.ts` | `defineService`, `loadService`, `loadModel` |
| `src/models/*.model.ts` | `defineModel`, `loadService`, `loadModel` (can compose other models) |
| `src/controllers/*.controller.ts` (http-next) | `defineController`, `loadService`, `loadModel` |
| `src/app/**/page.tsx` (http-next) | `loadModel` (only models from `src/models`) |
| `src/app/**/layout.tsx` (http-next) | `loadModel` optional (no `force-dynamic` required) |

---

## 16. File Naming Conventions

| Suffix | Type | Loaded by | Location constraint |
|--------|------|-----------|-------------------|
| `*.boot.ts` / `*.boot.js` | Service entry (auto-start) | CLI auto-scan | `src/services/` |
| `*.service.ts` / `*.service.js` | Service (lazy-loaded) | `loadService` | `src/services/` |
| `*.model.ts` / `*.model.js` | Business model | `loadModel` | `src/models/` |
| `*.controller.ts` / `*.controller.js` | HTTP controller | `http.load()` scan | Default `src/controllers/` |
| `*.msg.ts` / `*.msg.js` | Message handler | `loader.load()` scan | Custom (e.g. `src/messages/`) |
| `*.schedule.ts` / `*.schedule.js` | Scheduled job | `scheduler.load()` scan | Custom (e.g. `src/schedules/`) |
