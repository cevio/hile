---
name: hile
description: "Code generation guide for the Hile monorepo (@hile/* packages). Covers service container, HTTP APIs, database (TypeORM), Redis, logging, job scheduling, message communication, microservices, model pipeline, and project scaffolding. Use this skill when generating or editing code that depends on @hile/core, @hile/logger, @hile/schedule, @hile/http, @hile/typeorm, @hile/ioredis, @hile/cache, @hile/micro, @hile/model, @hile/message-*, or create-hile."
---

# Hile — AI Code Generation Guide

This document tells you **what to use when** and **how to use it correctly**. It is verified against source code, not documentation. For detailed explanations, see `docs/`.

---

## Decision Tree: Which Package for What?

```
Need to manage service lifecycle (init/shutdown order)?
  → @hile/core: defineService / loadService / container

Need to start an HTTP API server?
  → @hile/http: Http class + defineController

Need HTTP API + Next.js SSR on the same port?
  → @hile/http-next: HttpNext class

Need database access (MySQL/PostgreSQL/SQLite)?
  → @hile/typeorm: createDataSource (manual) or default export (container)

Need Redis?
  → @hile/ioredis: createRedis (manual) or default export (container)

Need typed cache with read-through on top of Redis?
  → @hile/cache: defineCache + RedisCache

Need process-to-process messaging (WebSocket / IPC / Worker)?
  → @hile/message-modem + one of: message-ws / message-ipc / message-worker-thread

Need file-system-based message routing?
  → @hile/message-loader: MessageLoader + defineMessage

Need service discovery + RPC across processes?
  → @hile/micro: Registry (discovery) + Application (service node)

Need runtime dynamic config with real-time push?
  → @hile/micro-dynamic-configs: MicroDynamicConfigsServer

Need structured logging?
  → @hile/logger: createLogger

Need cron jobs or delayed tasks?
  → @hile/schedule: Scheduler + defineJob

Need reusable business logic with middleware pipeline?
  → @hile/model: defineModel / loadModel

Need file-scanning utilities?
  → @hile/loader: scanDirectory / compileRoutePath / toRouterPath / Loader (abstract)

Need to scaffold a new project?
  → create-hile: npx create-hile create <name>
```

---

## 1. @hile/core — Service Container

**When to use:** Any time you have a resource (DB connection, HTTP server, Redis client, etc.) that needs managed startup and graceful shutdown. Also for any singleton that other code depends on.

### Core API

```typescript
import { defineService, loadService, container, isService, formatServiceKey } from '@hile/core'

// REGISTER — does NOT execute the factory function
const mySvc = defineService('my-key', async (shutdown) => {
  // shutdown is a function: shutdown(cleanupFn)
  const resource = await acquireResource()
  shutdown(() => resource.release())  // LIFO order on shutdown
  return resource
})

// RESOLVE — executes factory on first call, caches result
const instance = await loadService(mySvc)

// CONTAINER — global singleton, used directly for queries / event listening
container.hasService('my-key')          // has it been register()'d?
container.hasMeta('my-key')             // has it been resolve()'d?
container.getLifecycle('my-key')        // 'init' | 'ready' | 'stopping' | 'stopped' | undefined
container.getDependencyGraph()          // { nodes: ServiceKey[], edges: {from,to}[] }
container.getStartupOrder()             // ServiceKey[]
container.getMetaByKey('my-key')        // { status: -1|0|1, lifecycle, value, error, startedAt, endedAt }

// EVENTS — 9 event types, on() returns unsubscribe function
const off = container.on((event) => {
  // event.type:
  //   'service:init'        | 'service:ready'    | 'service:error'
  //   'service:shutdown:start' | 'service:shutdown:done' | 'service:shutdown:error'
  //   'container:shutdown:start' | 'container:shutdown:done' | 'container:error'
})
off()  // unsubscribe
container.off(listener)  // alternative

// SHUTDOWN — LIFO order, loops to catch late-registered teardowns
await container.shutdown()
```

### Dependency tracking (automatic)

When service A's factory calls `loadService(B)`, the container automatically records A→B. This is done via `AsyncLocalStorage` — transparent to you.

```typescript
const db = defineService('db', async (shutdown) => { /* ... */ })

const api = defineService('api', async (shutdown) => {
  const database = await loadService(db)  // auto-records: api → db
  return createServer(database)
})
```

### Container options (for isolated instances)

```typescript
import { Container } from '@hile/core'
const isolated = new Container({
  startTimeoutMs: 5000,     // reject if factory exceeds this
  shutdownTimeoutMs: 3000,  // skip teardown if it exceeds this
})
```

### isService — validate before loadService

```typescript
import { isService } from '@hile/core'
// Used by CLI to verify auto_load_packages exports are valid services
if (isService(mod.default)) {
  await loadService(mod.default)
}
```

---

## 2. @hile/cli — Boot & Auto-Loading

**When to use:** This is the runtime entry point. Every Hile app uses `hile start`. You don't import this package in code (except for programmatic start).

### How boot works

`hile start` does the following, in order:

1. Load `--env-file` files via `process.loadEnvFile()` (first-loaded wins for duplicate keys)
2. Set `NODE_ENV` (`--dev` → `'development'`, otherwise `'production'`)
3. If dev + not silent: subscribe container events → colored console output
4. Read `package.json` → `hile.auto_load_packages` (array of npm package names)
5. Scan files:
   - Dev: `src/**/*.boot.{ts,js}`
   - Production: `dist/**/*.boot.{ts,js}`
6. For each auto_load_packages entry: `import(pkg)` → if `isService(mod.default)` → `loadService(mod.default)`
7. For each boot file: `import(file)` → if `isService(mod.default)` → `loadService(mod.default)`
8. Register `async-exit-hook` → `container.shutdown()` on SIGINT/SIGTERM

### Boot file requirements

- Must be named `*.boot.ts` (dev) or `*.boot.js` (production)
- Can be placed **anywhere** under `src/` (dev) or `dist/` (production) — CLI uses `**/*.boot.{ts,js}` glob
- Must `export default` a `defineService(...)` return value

```typescript
// src/services/http.boot.ts — valid
export default defineService('http', async (shutdown) => { /* ... */ })

// src/app/boot.ts — ALSO valid (file name ends with .boot.ts)
export default defineService('app', async (shutdown) => { /* ... */ })
```

### auto_load_packages

```json
{
  "hile": {
    "auto_load_packages": ["@hile/typeorm", "@hile/ioredis", "@hile/logger"]
  }
}
```

Only works for packages whose **default export** is a `defineService(...)` return value. Currently: `@hile/typeorm`, `@hile/ioredis`, `@hile/logger`.

### CLI commands

```bash
hile start [name]            # start services, optionally for a specific package/dir
  --dev, -d                  # development mode (tsx, colored logs)
  --silent, -s               # suppress container event logs
  --env-file, -e <path>      # load env file (repeatable)

hile registry                 # start registry center
  --port <port>               # default 9876 (or REGISTRY_PORT env)
  --host <host>               # default 127.0.0.1

hile registry configs         # list config namespaces
hile registry configs get <ns> [--json]
hile registry configs set <ns> <key=value>
hile registry configs del <ns> [key] [-y]
```

---

## 3. @hile/http — HTTP API Server

**When to use:** Building REST APIs, HTTP endpoints. Underlying stack: Koa (middleware) + find-my-way (router).

### Http class

```typescript
import { Http } from '@hile/http'

const http = new Http({
  port: 3000,                    // required
  keys: ['secret1', 'secret2'], // optional, auto-generated if omitted
  ignoreDuplicateSlashes: true,  // default true
  ignoreTrailingSlash: true,     // default true
  maxParamLength: Infinity,      // default Infinity
  allowUnsafeRegex: false,       // default false
  caseSensitive: true,           // default true
})

// Global middleware (Koa middleware, onion model)
http.use(async (ctx, next) => {
  const start = Date.now(); await next()
  console.log(`${ctx.method} ${ctx.url} - ${Date.now() - start}ms`)
})

// Manual routes (each returns unregister function)
http.get('/users', handler)
http.post('/users', handler)
http.put('/users/:id', handler)
http.delete('/users/:id', handler)
http.patch('/users/:id', handler)
http.trace('/debug', handler)
http.route('OPTIONS', '/users', handler)  // generic

// File-system route loading
await http.load('./src/controllers', {
  suffix: 'controller',       // match *.controller.{ts,js,tsx,jsx}
  prefix: '/api',             // URL prefix
  defaultSuffix: '/index',   // index.controller → / (parent path)
  conflict: 'error',         // 'error' | 'warn' | 'override'
})

// Start & stop
const close = await http.listen()                // starts HTTP server
const close = await http.listen((server) => {})  // with callback
close()  // stop server
```

### Route mapping from file names

```
src/controllers/hello.controller.ts       → /api/hello
src/controllers/users/index.controller.ts → /api/users
src/controllers/users/[id].controller.ts  → /api/users/:id
src/controllers/users/[id]/posts.controller.ts → /api/users/:id/posts
```

### defineController (3 overloads)

```typescript
import { defineController, createControllerMetadata } from '@hile/http'
import { z } from 'zod'

// Overload 1: method + handler (no Zod)
export default defineController('GET', async (ctx) => {
  return { items: [] }  // return value becomes ctx.body via response plugin chain
})

// Overload 2: method + middlewares + handler
export default defineController('POST', [authMiddleware], async (ctx) => {
  return { created: true }
})

// Overload 3: metadata + handler (with Zod validation)
export default defineController(
  createControllerMetadata({
    method: 'GET',
    middlewares: [],        // optional
    schema: {
      query: z.object({ page: z.coerce.number().default(1) }),
      params: z.object({ id: z.coerce.number() }),
      body: z.object({ name: z.string() }),
    },
  }),
  async (ctx) => {
    // Zod validates but does NOT transform ctx.query/params/body types
    // Validation failure → automatic ctx.throw(400)
    return { page: ctx.query.page }
  }
)

// One file can export multiple controllers:
export default [
  defineController('GET', getHandler),
  defineController('POST', postHandler),
]
```

### Response plugins (global post-processing)

```typescript
import { defineResponsePlugin } from '@hile/http'

defineResponsePlugin(async (ctx, result, next) => {
  // result = controller's return value
  // Pass transformed value to next plugin in chain
  return await next({ code: 0, data: result })
})
```

### Route conflict strategies

| Strategy | Behavior |
|----------|----------|
| `'error'` (default) | Throw on duplicate method+path |
| `'warn'` | Console.warn, keep existing |
| `'override'` | Remove old, register new |

---

## 4. @hile/http-next — HTTP + Next.js Same Port

**When to use:** Full-stack apps where API routes and Next.js pages share port 3000. Combines Koa (API) + Next.js (SSR/SSG) + koa-static (static files).

### HttpNext class

```typescript
import HttpNext from '@hile/http-next'

const app = new HttpNext({
  port: 3000,
  cwd: '/path/to/project',              // default process.cwd()
  publicPath: 'public',                  // or ['public', 'uploads']
  controllerDirectory: 'controllers',    // default 'controllers'
  controllerPrefix: '/-',               // default '/-'
  controllerSuffix: 'controller',       // default 'controller'
  specialControllers: [                  // extra controller dirs with own prefix
    { directory: 'admin/controllers', prefix: '/admin' },
  ],
  nextArtifactsDir: '.next',            // default cwd/.next
})

// Middleware (forwarded to internal Http instance)
app.use(async (ctx, next) => { /* ... */ })

// Manual controller loading
app.load('./extra-controllers')

// Start (returns stop function)
const stop = await app.start()
```

### Request processing order (4 layers)

```
Request → koa-static(public/) → koa-static(.next/static/) → API controllers → Next.js handler
```

API routes use `/-` prefix by default to avoid conflicts with Next.js pages. Next.js handler is last — it's the fallback.

### Dev vs Production

| | development | production |
|---|-------------|------------|
| Controller dir | `src/controllers/` | `dist/controllers/` |
| Next.js | `dev: true` (HMR) | `dev: false` |
| TypeScript | tsx live compile | pre-compiled JS |

---

## 5. @hile/typeorm — Database (TypeORM)

**When to use:** Need a SQL database. Two modes: container (auto-managed lifecycle) or manual (direct control).

### Container mode (recommended for apps)

```json
// package.json
{ "hile": { "auto_load_packages": ["@hile/typeorm"] } }
```

```typescript
import { loadService } from '@hile/core'
import typeormService from '@hile/typeorm'

// Inside any service factory:
const ds = await loadService(typeormService)
// ds is a fully initialized TypeORM DataSource
```

### Manual mode

```typescript
import { createDataSource } from '@hile/typeorm'

// From env vars
const ds = await createDataSource()

// With explicit options
const ds = await createDataSource({
  type: 'mysql', host: 'localhost', port: 3306,
  username: 'root', password: 'secret', database: 'mydb',
  entities: [User, Post],
})

await ds.destroy()  // manual cleanup
```

### Env vars

`TYPEORM_TYPE`, `TYPEORM_HOST`, `TYPEORM_USERNAME`, `TYPEORM_PASSWORD`, `TYPEORM_DATABASE`, `TYPEORM_PORT`, `TYPEORM_CHARSET`, `TYPEORM_ENTITY_PREFIX`, `TYPEORM_ENTITIES`, `TYPEORM_SYNCHRONIZE` (string `"true"` to enable)

### Transaction with LIFO compensation

```typescript
import { transaction } from '@hile/typeorm'

await transaction(ds, async (runner, rollback) => {
  await runner.query('INSERT INTO users (name) VALUES (?)', ['Alice'])

  rollback(async () => { cache.del('user:alice') })   // compensation 1
  rollback(async () => { notifyRollback() })           // compensation 2

  if (somethingFailed) throw new Error('abort')
  // On failure: rollbackTransaction → execute compensations LIFO (2 then 1)
  return result
})
// On success: commitTransaction, compensations NOT executed
```

---

## 6. @hile/ioredis — Redis

**When to use:** Need Redis for caching, sessions, queues, pub/sub.

### Container mode (recommended)

```json
{ "hile": { "auto_load_packages": ["@hile/ioredis"] } }
```

```typescript
import { loadService } from '@hile/core'
import redisService from '@hile/ioredis'

const redis = await loadService(redisService)
// redis is a fully connected ioredis instance
```

### Manual mode

```typescript
import { createRedis } from '@hile/ioredis'

const redis = await createRedis()                          // from env
const redis = await createRedis({ host: 'x', port: 6379 }) // explicit
await redis.disconnect()
```

### Env vars

`REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`, `REDIS_DB`

---

## 7. @hile/cache — Typed Redis Cache

**When to use:** Need read-through caching with typed cache keys. Built on top of `@hile/ioredis`.

```typescript
import { defineCache, Cache, RedisCache } from '@hile/cache'

// Define a cache with typed key template
// Supported types: string, number, boolean
const userCache = defineCache('user:{id:string}:profile', async ({ id }) => {
  const user = await db.findUser(id)
  if (!user) return new Cache(undefined)   // cache miss → nothing stored
  return new Cache(user).setExpire(300)    // TTL 300 seconds
})

// Usage
const cache = new RedisCache('myapp:')  // prefix = namespace
const ops = await cache.loadCache(userCache)

await ops.read({ id: 'u-001' })     // Read-through: miss → fetch → cache → return
await ops.write({ id: 'u-001' })    // Force fetch + update cache
await ops.remove({ id: 'u-001' })   // Delete from cache (returns 1 or 0)
await ops.has({ id: 'u-001' })      // Exists check (no fetch)

// Cache-Aside pattern:
// UPDATE: update DB → ops.remove(key)  // next read auto-refreshes
```

---

## 8. Message Communication Stack

### When to use which transport

| Scenario | Package | Base class to extend |
|----------|---------|---------------------|
| Different machines/processes, TCP | `@hile/message-ws` | `MessageWs` |
| Parent-child processes (fork) | `@hile/message-ipc` | `MessageIpc` |
| Worker threads | `@hile/message-worker-thread` | `MessageWorkerThread` |

### @hile/message-modem — Protocol base

All transport classes inherit from `MessageModem`. You implement two methods:

```typescript
import { MessageModem, MessageTransferFormat } from '@hile/message-modem'

class MyTransport extends MessageModem {
  // REQUIRED: How to send raw data to remote end
  protected post<T>(data: MessageTransferFormat<T>): void {
    transport.send(JSON.stringify(data))
  }

  // REQUIRED: How to process received requests
  protected async exec(data: any, signal?: AbortSignal): Promise<any> {
    return processData(data)
  }

  // AVAILABLE (protected methods):
  // this._send(data, opts?)  — bidirectional request, returns Promise<response>
  // this._push(data, opts?)  — one-way push, returns void
  // this._stream(data, opts?) — streaming request, returns Readable
  // this._dispose()          — cleanup all pending
  // this.receive(msg)        — call when data arrives from remote
}

// Usage:
const result = await modem._send({ url: '/hello', data: 'world' })
const result = await modem._send(data, { timeout: 5000, signal: abortSig })
modem._push({ url: '/log', data: 'info' })
const stream = modem._stream({ url: '/events' })
for await (const chunk of stream) { /* ... */ }
```

### @hile/message-ws — WebSocket

Constructor takes a **connected** WebSocket instance. JSON serialization.

```typescript
import { MessageWs } from '@hile/message-ws'
import WebSocket from 'ws'

class MyWs extends MessageWs {
  protected async exec(data: any, signal?: AbortSignal): Promise<any> {
    return { received: true, data }
  }
  public request(data: any, timeout?: number) { return this._send(data, { timeout }) }
}

const ws = new WebSocket('ws://localhost:8080')
ws.on('open', () => { const m = new MyWs(ws); m.request('hello') })
m.dispose()  // remove listeners + cleanup
```

### @hile/message-ipc — Process IPC

- Parent side: `new MyIpc(forkedChild)`
- Child side: `new MyIpc()` (auto-binds `process`)

```typescript
import { MessageIpc } from '@hile/message-ipc'
import { fork } from 'child_process'

class MyIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> { return { ok: true } }
}
const child = fork('./worker.js'); const ipc = new MyIpc(child)
ipc.dispose(); child.kill()
```

### @hile/message-worker-thread — Worker Threads

- Main thread: `new MyWT(worker)`
- Worker thread: `new MyWT()` (auto-binds `parentPort`)

```typescript
import { MessageWorkerThread } from '@hile/message-worker-thread'
import { Worker } from 'worker_threads'

class MyWT extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> { return { ok: true } }
}
const worker = new Worker('./worker.mjs'); const wt = new MyWT(worker)
wt.dispose(); await worker.terminate()
```

### @hile/message-loader — File-system message routing

```typescript
// src/messages/hello.msg.ts
import { defineMessage } from '@hile/message-loader'
export default defineMessage(async ({ params, data, url }) => {
  return { greeting: `Hello ${data.name}` }
})
// File maps to route: /hello (with default prefix) or /-/hello (with prefix '/-')

// Loading:
import { MessageLoader } from '@hile/message-loader'
const loader = new MessageLoader({ suffix: 'msg', prefix: '/-', defaultSuffix: '/index' })
await loader.load('./src/messages')

// Dispatch:
const result = await loader.dispatch('/-/hello', { name: 'World' })

// Manual registration:
loader.register('/custom', async ({ data }) => ({ done: true }))
```

Route mapping: `users/[id].msg.ts` → `/users/:id`, `users/index.msg.ts` → `/users`

### Combining transport + loader

```typescript
class MyWs extends MessageWs {
  constructor(ws: WebSocket, private loader: MessageLoader) { super(ws) }
  protected async exec(data: { url: string; data: any }): Promise<any> {
    return this.loader.dispatch(data.url, data.data)
  }
}
```

---

## 9. @hile/micro — Microservices

### Class hierarchy

```
MessageModem → MessageWs → Client
Loader → MessageLoader → Server → Registry
                                → Application
```

### Server — WebSocket server + routing

```typescript
import { Server } from '@hile/micro'

const server = new Server('namespace', { advertiseHost: '127.0.0.1' })
const teardown = await server.listen(9100)

server.register('/hello', async ({ data, client }) => ({ ok: true }))
await server.load('./src/messages')  // file-system routing
server.connect('10.0.0.2', 9200)    // outbound connection

server.events.on('connect', (client) => {})
server.events.on('disconnect', (client) => {})
server.handleUpgrade(req, socket, head)  // mount on existing HTTP server
await teardown()
```

### Registry — Service discovery center

```typescript
import { Registry } from '@hile/micro'
const registry = new Registry({ advertiseHost: '127.0.0.1' })
await registry.listen(9876)
```

Built-in routes: `/-/find` (discovery), `/-/declare` / `/-/undeclare` (topic publish), `/-/subscribe` / `/-/unsubscribe` (topic subscribe), `/-/topic/update` (push update).

Watches `~/.registry/configs/*.config.yaml` for file-based config.

### Application — Service node (provider + consumer)

```typescript
import { Application } from '@hile/micro'

const app = new Application({
  namespace: 'my-service',
  registry: { host: '127.0.0.1', port: 9876 },
  advertiseHost: '127.0.0.1',
  registryLookupTimeoutMs: 10_000,  // default
  requestTimeoutMs: 30_000,          // default
})

// Register message handlers (provider side)
app.register('/charge', async ({ data, params, client }) => ({ done: true }))
await app.load('./src/messages')  // file-system routing (recommended)

// Call other services (consumer side)
const result = await app.call('other-service', '/hello', { name: 'Alice' })
const result = await app.call('other-svc', '/slow', data, {
  timeout: 5000,      // overrides requestTimeoutMs
  retries: 2,         // default 1
  signal: abortSig,
})

// Streaming RPC
const stream = await app.stream('data-svc', '/events', { query: '...' })
for await (const chunk of stream) { /* ... */ }

// Pub/Sub (async, requires connected Registry)
const ref = await app.publish('order.created', { orderId: 1 })
await ref.update({ orderId: 1, status: 'paid' })   // push update
await ref.unpublish()                                 // retire topic

const unsub = await app.subscribe('order.created', (data) => {
  console.log('received:', data)
})
// Re-subscribing same topic is idempotent (returns existing unsubscribe)
unsub()  // stop listening

// Health check (auto-registered)
const health = await app.dispatch('/-/health', {})
// { status: 'ok', registry: true, uptime: 123, namespaces: [...] }

await app.listen(0)  // 0 = random port
```

### Built-in reliability

- **Circuit breaker**: Failed nodes excluded for 30s cooldown. All excluded → auto-reset.
- **Cache degradation**: Registry unavailable → uses last-known-good addresses.
- **Auto-reconnect**: Registry disconnect → retry every 3s. Re-subscribes all topics on reconnect.
- **Heartbeat**: Client sends heartbeat per `MICRO_HEARTBEAT_INTERVAL` (default 10s), timeout at `MICRO_HEARTBEAT_TIMEOUT` (default 20s).

---

## 10. @hile/micro-dynamic-configs — Runtime Config

**When to use:** Need configuration that can be changed at runtime without restarting services. Persisted to Redis, pushed via Registry topics.

```typescript
import { MicroDynamicConfigsServer } from '@hile/micro-dynamic-configs'
import { z } from 'zod'

const schema = z.object({
  featureX: z.boolean().default(false),
  maxRetries: z.number().int().min(1).max(10).default(3),
})

const server = new MicroDynamicConfigsServer({ app, redis, schema, redis_key: 'app:config' })
await server.initialize()  // load from Redis, publish all fields to Registry

console.log(server.value.featureX)  // read current value

await server.save({ featureX: true })  // validate → Redis.set → topic push → emit event

server.on('change:featureX', (newVal, oldVal) => {
  console.log(`featureX: ${oldVal} → ${newVal}`)
})
```

Data flow: `save()` → Zod validate → Redis persist → `app.publish()` → Registry pushes to subscribers → `emit('change:key')`

---

## 11. @hile/model — Business Logic Pipeline

**When to use:** Reusable business logic that needs dependency injection (container services) and/or middleware pipeline (validation, logging, etc.).

```typescript
import { defineModel, loadModel } from '@hile/model'
import typeormService from '@hile/typeorm'

// Full form: services + pipelines + main
const userModel = defineModel({
  services: [typeormService] as const,  // auto loadService'd
  pipelines: [
    async (ctx, next) => {  // ctx.args = the input object
      if (!ctx.args.userId) throw new Error('userId required')
      await next()
    },
  ],
  async main([ds], input: { userId: number }) {
    return ds.manager.findOne(User, { where: { id: input.userId } })
  },
})

// Simple form: just a function
const greet = defineModel(async (input: { name: string }) => {
  return { greeting: `Hello ${input.name}` }
})

// Usage: each call re-executes main
const user = await loadModel(userModel, { userId: 1 })
```

`loadModel(model, input)` — input must be an object. `isModel(value)` checks if something is a valid model definition.

---

## 12. @hile/logger — Structured Logging

**When to use:** Any logging need. Based on pino.

```typescript
import { createLogger } from '@hile/logger'

const logger = createLogger({
  level: 'info',                       // 'trace'|'debug'|'info'|'warn'|'error'|'fatal'
  pretty: true,                        // default: NODE_ENV !== 'production'
  redact: ['password', 'authorization'],
})

logger.info({ userId: 1 }, 'user created')
logger.error({ err }, 'something failed')
logger.child({ module: 'payment' })  // pino child logger
```

Defaults: `level` from `LOG_LEVEL` env (fallback `'info'`). `pretty` auto-enabled in non-production.

Also available as container service (default export): add `@hile/logger` to `auto_load_packages`.

---

## 13. @hile/schedule — Job Scheduling

**When to use:** Cron jobs, delayed tasks. Based on node-schedule.

```typescript
import { Scheduler, defineJob } from '@hile/schedule'

const scheduler = new Scheduler()

// Cron
scheduler.add('daily', '0 8 * * *', async () => { /* ... */ })

// Delay (ms)
scheduler.add('once', { delay: 5000 }, async () => { /* ... */ })

// File-system loading
await scheduler.load('./src/tasks', { suffix: 'schedule' })  // *.schedule.{ts,js}

// Management
scheduler.remove('daily')    // cancel one
scheduler.stop()             // cancel all
scheduler.getJobs()          // [{ id, type: 'cron'|'delay', expression }]
```

### defineJob for file-based tasks

```typescript
// src/tasks/report.schedule.ts
import { defineJob } from '@hile/schedule'
export default defineJob('0 8 * * *', async () => {
  console.log('daily report')
})
```

---

## 14. @hile/loader — File System Utilities

**When to use:** Building custom file-system loaders. `@hile/http` and `@hile/message-loader` both use it internally.

```typescript
import { scanDirectory, compileRoutePath, toRouterPath, normalizePath, Loader } from '@hile/loader'

// Scan directory for files matching suffix
const files = await scanDirectory('./dir', { suffix: 'handler' })
// Returns: [{ absolute, relative, routePath }, ...]

// Path utilities
compileRoutePath('/users/index', { defaultSuffix: '/index', prefix: '/api' })  // '/api/users'
toRouterPath('users/[id]/posts')     // 'users/:id/posts'
normalizePath('a\\b//c')             // 'a/b/c'

// Build a custom loader by extending Loader
class MyLoader extends Loader<MyFileType> {
  protected bind(file, module) {
    // register module to your system, return unregister function
  }
}
```

---

## 15. create-hile — Project Scaffolding

```bash
npx create-hile create my-project
npx create-hile create my-project --skip-install
```

6 templates: `default`, `next`, `micro-http`, `micro`, `micro-http-next`, `monorepo`

---

## 16. Anti-Patterns

```typescript
// ❌ loadService at module top level (causes side-effect on import)
import { loadService } from '@hile/core'
const instance = await loadService(someService)  // NEVER do this

// ❌ Boot file exports something other than defineService result
export default async () => { /* ... */ }  // must be defineService(...)

// ❌ auto_load_packages uses file paths
{ "hile": { "auto_load_packages": ["./src/my-service.ts"] } }  // must be npm package names

// ❌ Controller BOTH sets ctx.body AND returns a value
export default defineController('GET', async (ctx) => {
  ctx.body = { x: 1 }  // don't do this
  return { x: 1 }      // only return
})

// ❌ Passing non-ServiceRegisterProps to loadService
await loadService({ key: 'x', fn: () => {} })  // missing internal flag, will fail
// Only pass return values from defineService()

// ❌ Re-using the same service key for different factories
defineService('same-key', async () => 'A')
defineService('same-key', async () => 'B')
// The first one to be loadService'd wins; second is effectively ignored

// ❌ Forgetting shutdown callback for resources
defineService('db', async (shutdown) => {
  const conn = await createConnection()
  return conn  // BUG: no shutdown(() => conn.close())
})

// ❌ Not awaiting loadService
const val = loadService(svc)  // val is Promise, not the actual value
```

---

## 17. Key Conventions

| Convention | Detail |
|-----------|--------|
| Boot files | `*.boot.ts` / `*.boot.js`, scanned by CLI with `**/*.boot.{ts,js}` glob |
| Controller files | `*.controller.{ts,js,tsx,jsx}`, loaded by `http.load()` with configurable suffix |
| Message files | `*.msg.{ts,js,tsx,jsx}`, loaded by `MessageLoader.load()` / `app.load()` |
| Schedule files | `*.schedule.{ts,js,tsx,jsx}`, loaded by `Scheduler.load()` |
| Service keys | `kebab-case` strings for app services, `Symbol.for('pkg-name')` for integration packages |
| ESM only | All packages are ESM. Projects need `"type": "module"` in package.json |
