# Hile Package Map

Use this map to decide what to read.

## Package Selection Matrix

| User asks for | Use | Also read |
|---|---|---|
| Start an app, manage lifecycle, graceful shutdown | `@hile/core`, `@hile/cli`, `@hile/bootstrap` | `packages/core-lifecycle.md` |
| Create an HTTP endpoint or Koa middleware | `@hile/http` | `packages/http.md`, `recipes/http-api-model-typeorm.md` |
| Run Next.js and API controllers on one port | `@hile/http-next` | `packages/http-next.md`, `recipes/http-next-fullstack.md` |
| Run independently built RSC plugins through one Host | `@hile/rsc` | `packages/rsc.md`, `recipes/rsc-plugin-host.md` |
| Compile immutable production RSC plugin artifacts | `@hile/rsc-build` | `packages/rsc.md` |
| Add incremental RSC development and hot reload | `@hile/rsc-development` | `packages/rsc.md` |
| Decode plugin Flight inside a Next Host | `@hile/rsc-next` | `packages/rsc.md`, `recipes/rsc-plugin-host.md` |
| Put business logic somewhere reusable | `@hile/model` | `packages/model-context.md` |
| Propagate request id, tenant id, logger bindings, or micro context | `@hile/context` | `packages/model-context.md` |
| Connect to SQL through TypeORM | `@hile/typeorm` | `packages/core-lifecycle.md`, `packages/infrastructure.md` |
| Connect to Redis | `@hile/ioredis` | `packages/core-lifecycle.md`, `packages/infrastructure.md` |
| Create structured logs | `@hile/logger` | `packages/core-lifecycle.md`, `packages/infrastructure.md` |
| Add read-through Redis cache | `@hile/cache` | `packages/infrastructure.md`, `recipes/redis-cache-singleflight.md` |
| Run cron or delayed jobs | `@hile/schedule` | `packages/infrastructure.md` |
| Build a custom file loader or understand route mapping | `@hile/loader` | `packages/infrastructure.md` |
| Add request/response messaging over WS/IPC/worker | `@hile/message-*` | `packages/messaging-micro.md` |
| Load file-based message handlers | `@hile/message-loader` | `packages/messaging-micro.md`, `recipes/micro-rpc-message-loader.md` |
| Build service discovery or RPC | `@hile/micro` | `packages/messaging-micro.md`, `recipes/micro-rpc-message-loader.md` |
| Expose distributed microservice capabilities through one MCP server | `@hile/mcp` | `packages/mcp.md`, `recipes/mcp-distributed-gateway.md` |
| Push runtime config without restarts | `@hile/micro-dynamic-configs` | `packages/messaging-micro.md`, `recipes/runtime-config.md` |
| Stabilize config-driven runtime reloads | `@hile/reloader` | `packages/reloader.md`, `recipes/stable-runtime-reload.md` |
| Compose topics, config, and reloader state as refs | `@hile/reactivity` | `packages/reactivity.md`, `recipes/stable-runtime-reload.md` |
| Protect a critical section with a lease | `@hile/redis-lock` | `packages/redis-reliability.md` |
| Stop duplicate retry side effects | `@hile/redis-idempotency` | `packages/redis-reliability.md`, `recipes/queue-worker-idempotency.md` |
| Enforce shared quotas or 429s | `@hile/redis-rate-limit` | `packages/redis-reliability.md` |
| Persist and retry background jobs | `@hile/redis-stream-queue` | `packages/redis-reliability.md`, `recipes/queue-worker-idempotency.md` |
| Scaffold a new project | `create-hile` | `packages/create-hile.md`, `recipes/new-project-scaffold.md` |

## Common Selection Rules

- If the task is a user-facing API, start with `@hile/http` or `@hile/http-next`.
- If the task is reusable business behavior, put it in `@hile/model` even if the caller is HTTP, Next.js, queue, or micro.
- If the task may retry or redeliver and has side effects, add `@hile/redis-idempotency`.
- If the task is background work, use `@hile/redis-stream-queue`; do not use micro RPC as a queue.
- If the task is "only one replica should run this", use `@hile/redis-lock` or `@hile/schedule` distributed mode, and keep a final business consistency wall.
- If the task is "prevent too many attempts", use `@hile/redis-rate-limit`; do not confuse it with authentication or idempotency.
- If config changes can arrive in bursts, use `@hile/reloader` around the runtime; do not reload directly inside every subscribe callback.
- If service code needs refs or async watch strategies for topics/config/reloader state, use `@hile/reactivity`.
- If tools, resources, and prompts belong to different microservices, use `@hile/mcp`; do not centralize their handlers in the gateway.

## Project Startup And Lifecycle

Read `packages/core-lifecycle.md` when the task mentions:

- service container
- boot files
- startup/shutdown
- auto-loaded services
- `hile start`
- graceful exit

Packages: `@hile/core`, `@hile/bootstrap`, `@hile/cli`, `@hile/logger`, `@hile/ioredis`, `@hile/typeorm`.

## HTTP APIs

Read `packages/http.md` when the task mentions:

- REST endpoints
- Koa middleware
- controllers
- Zod validation
- response formatting
- file-system routes

Packages: `@hile/http`, `@hile/loader`.

## Next.js On The Same Port

Read `packages/http-next.md` when the task mentions:

- Next.js
- App Router
- SSR on the same port as API routes
- `/-` API prefix

Package: `@hile/http-next`.

## Dynamic RSC Plugins

Read `packages/rsc.md` when the task mentions:

- independently built Next/React page plugins
- React Server Components or Flight streams
- plugin-owned `'use client'` components
- one public Next host with internal plugin microservices
- plugin install, upgrade, drain, deactivate, or artifact integrity

Core package: `@hile/rsc`. Compose `@hile/rsc-build` for production compilation, `@hile/rsc-development` only in development, and `@hile/rsc-next` only in the Next Host. Also compose with `@hile/http-next`, `@hile/micro`, and the message transport packages.

## Business Logic And Context

Read `packages/model-context.md` when the task mentions:

- reusable domain logic
- pipeline middleware
- request/work-unit context
- logger context bindings
- context propagation into micro calls or queue jobs

Packages: `@hile/model`, `@hile/context`.

## Infrastructure Helpers

Read `packages/infrastructure.md` when the task mentions:

- TypeORM
- Redis clients
- logger
- scheduler
- custom file loader
- typed Redis cache

Packages: `@hile/typeorm`, `@hile/ioredis`, `@hile/logger`, `@hile/schedule`, `@hile/loader`, `@hile/cache`.

## Messaging And Microservices

Read `packages/messaging-micro.md` when the task mentions:

- WebSocket/IPC/worker messaging
- `defineMessage`
- service registry
- `Application.call`
- streaming RPC
- pub/sub topics

Packages: `@hile/message-modem`, `@hile/message-ws`, `@hile/message-ipc`, `@hile/message-worker-thread`, `@hile/message-loader`, `@hile/micro`, `@hile/micro-dynamic-configs`, `@hile/reloader`.

## Distributed MCP Capabilities

Read `packages/mcp.md` when the task mentions:

- Model Context Protocol or MCP
- tools, resources, prompts, progress, logging, or input-required flows
- one public MCP endpoint backed by multiple microservices
- MCP provider discovery, replicas, conflict detection, or failover
- MCP completion, resource subscriptions, list-change notifications, or OAuth Resource Server behavior
- Streamable HTTP or stdio MCP transport

Package: `@hile/mcp`. Compose it with `@hile/micro`, an existing `@hile/http` server for remote access, and `@hile/core` for lifecycle management.

## Runtime Reload And Config Aggregation

Read `packages/reloader.md` when the task mentions:

- debounce config reloads
- aggregate multiple subscribe values
- stable reload of runtime state
- keep HTTP port stable while changing handlers
- prevent concurrent create/dispose cycles

Package: `@hile/reloader`.

## Runtime Reactivity

Read `packages/reactivity.md` when the task mentions:

- topic refs
- config refs
- reactive reloader state
- async watch latest-wins
- serial topic publishing
- composing micro config with refs

Package: `@hile/reactivity`.

## Redis Reliability

Read `packages/redis-reliability.md` when the task mentions:

- distributed locks
- idempotency
- rate limits
- durable queues
- retries
- DLQ
- singleflight

Packages: `@hile/redis-lock`, `@hile/redis-idempotency`, `@hile/redis-rate-limit`, `@hile/redis-stream-queue`.

## Scaffolding

Read `packages/create-hile.md` when the task mentions:

- new project
- templates
- `npx create-hile`
- monorepo template

Package: `create-hile`.

## Cross-Package Recipes

- HTTP API + model + TypeORM: `recipes/http-api-model-typeorm.md`
- HttpNext fullstack app: `recipes/http-next-fullstack.md`
- Redis cache with singleflight: `recipes/redis-cache-singleflight.md`
- Queue worker with idempotency: `recipes/queue-worker-idempotency.md`
- Micro RPC with message loader: `recipes/micro-rpc-message-loader.md`
- Distributed MCP providers and unified gateway: `recipes/mcp-distributed-gateway.md`
- Runtime dynamic config: `recipes/runtime-config.md`
- Stable runtime reload: `recipes/stable-runtime-reload.md`
- New scaffolded project: `recipes/new-project-scaffold.md`
