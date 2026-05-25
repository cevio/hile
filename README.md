# Hile

Hile is a lightweight Node.js service toolkit built on an async service container. It provides a structured way to build HTTP APIs, database-backed services, Redis-cached endpoints, microservices, and Next.js-integrated applications.

## Quick Start

```bash
npx create-hile create my-app
cd my-app
pnpm install
pnpm run dev
```

Choose from templates: `default` (plain HTTP), `next` (Next.js + API), `micro` (pure microservice), `micro-http`, `micro-http-next`, or `monorepo`.

## Packages

Hile is organized as a monorepo. Pick what you need:

| Package | Purpose |
|---------|---------|
| `@hile/core` | Async service container — singleton lifecycle, dependency resolution, graceful shutdown |
| `@hile/cli` | CLI launcher — auto-scans boot files, loads services declared in `package.json` |
| `@hile/http` | HTTP framework (Koa) — file-system routing, middleware, optional Zod validation |
| `@hile/http-next` | Embed Next.js as a render engine inside `@hile/http` on the same port |
| `@hile/typeorm` | TypeORM DataSource wrapped as a Hile service, with transaction helpers |
| `@hile/ioredis` | Redis client wrapped as a Hile service |
| `@hile/cache` | Declarative cache key templates with typed parameters |
| `@hile/message-modem` | Transport-agnostic request/response messaging (abstract base for IPC/WS/threads) |
| `@hile/message-ipc` | Parent-child process IPC based on message-modem |
| `@hile/message-worker-thread` | Worker thread messaging based on message-modem |
| `@hile/message-ws` | WebSocket client/server messaging based on message-modem |
| `@hile/message-loader` | File-system message routing — maps directory structure to routes |
| `@hile/micro` | WebSocket-based service registry and discovery |
| `@hile/model` | Business pipeline with middleware chains and auto-resolved service dependencies |

## Getting Started with a Template

```
Template           | Use Case
-------------------|-------------------------------------------
default            | HTTP API (Koa + @hile/http)
next               | Next.js app with API routes on the same port
micro-http         | Microservice with an HTTP endpoint
micro              | Pure microservice (no HTTP)
micro-http-next    | Full-stack: Next.js + microservice + HTTP
monorepo           | Multi-package workspace (Lerna + pnpm)
```

Run `npx create-hile create <name>` and pick a template. The scaffolded project includes a working service boot file, a sample controller, and proper shutdown handling.

## Development

```bash
git clone https://github.com/cevio/hile.git
pnpm install
pnpm run build
pnpm run test
```

| Command | What it does |
|---------|-------------|
| `pnpm run build` | Build all packages |
| `pnpm run test` | Run all package tests |
| `pnpm run dev` | Watch mode for all packages |

## License

MIT
