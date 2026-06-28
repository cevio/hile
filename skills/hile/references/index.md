# Hile AI Context

Hile is a lightweight Node.js service toolkit for building HTTP APIs, Next.js-integrated apps, microservices, jobs, Redis-backed reliability primitives, and reusable business models.

Use this AI context to generate code against the current Hile APIs. Treat source code and tests as truth when a README or MDX page disagrees.

## First Move

1. Identify the user's task.
2. Read `package-map.md` to choose package cards and recipes.
3. Read `conventions.md` before writing files.
4. Read `anti-patterns.md` before finalizing.
5. Generate code that follows Hile lifecycle boundaries and verifies cleanup.

## Core Mental Model

- `@hile/core` manages resources as async services. A boot file starts things; `shutdown()` callbacks release them.
- `@hile/http` exposes Koa routes and file-system controllers.
- `@hile/model` is the reusable business-logic layer. Controllers and Next.js pages should call models instead of duplicating domain logic.
- `@hile/micro` uses message loaders and WebSocket clients for service discovery and RPC.
- Redis primitives (`redis-lock`, `redis-idempotency`, `redis-rate-limit`, `redis-stream-queue`, `cache`) are distributed coordination helpers, not exactly-once systems.

## Output Style For Agents

When implementing with Hile:

- Show exact files and imports.
- Prefer minimal working code plus production lifecycle cleanup.
- Use ESM imports and include file extensions only when the local project already requires them.
- Never invent methods that are not exported by the package.
- Do not preserve old message examples that append a secondary response getter; current message APIs return promises or streams directly.
