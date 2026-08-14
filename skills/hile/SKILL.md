---
name: hile
description: "Example-first AI development guide for Hile @hile/* packages. Use when building or editing Node.js/TypeScript services with @hile/core, @hile/http, @hile/http-next, @hile/rsc, @hile/model, @hile/context, @hile/typeorm, @hile/ioredis, @hile/cache, @hile/message-*, @hile/micro, @hile/reloader, Redis reliability packages, @hile/schedule, or create-hile."
license: MIT
metadata:
  version: "1.0.0"
  author: Hile
  tags:
    - nodejs
    - typescript
    - backend
    - hile
    - redis
    - microservices
    - nextjs
---

# Hile AI Development Skill

Use this skill to generate or edit Hile applications with the current `@hile/*` APIs. Keep the body lean; load only the relevant references for the task.

## Required Workflow

1. Read `references/package-map.md` to choose the package card and recipe for the user request.
2. Read `references/conventions.md` before editing code.
3. Start from the closest complete example in `references/packages/*.md` or `references/recipes/*.md`.
4. Read `references/anti-patterns.md` before finalizing.
5. If docs conflict with source code or tests in a Hile repository, trust source/tests and update the docs.

## High-Risk Rules

- Do not call `loadService()` at module top level; call it inside boot services, controllers, models, message handlers, queue workers, or functions.
- Load `@hile/http` controllers before `http.listen()` in new code.
- `@hile/http` Zod validation validates only; parse again when the handler needs coerced data.
- `MessageModem._send()` and `Application.call()` return promises. Await them directly.
- Redis lock, idempotency, rate limit, cache, and queue helpers are not exactly-once guarantees.
- Queue handlers and retryable HTTP/RPC handlers with side effects need idempotency or a stronger business uniqueness wall.

## Reference Router

Always begin with:

- `references/package-map.md`: choose what package solves the task.
- `references/conventions.md`: lifecycle, ESM, file layout, and response conventions.
- `references/anti-patterns.md`: failure modes to avoid before finalizing.

Then load the relevant package card or recipe:

- `references/anti-patterns.md`
- `references/conventions.md`
- `references/index.md`
- `references/package-map.md`
- `references/packages/core-lifecycle.md`
- `references/packages/create-hile.md`
- `references/packages/http-next.md`
- `references/packages/http.md`
- `references/packages/infrastructure.md`
- `references/packages/mcp.md`
- `references/packages/messaging-micro.md`
- `references/packages/model-context.md`
- `references/packages/reactivity.md`
- `references/packages/redis-reliability.md`
- `references/packages/reloader.md`
- `references/packages/rsc.md`
- `references/recipes/http-api-model-typeorm.md`
- `references/recipes/http-next-fullstack.md`
- `references/recipes/mcp-distributed-gateway.md`
- `references/recipes/micro-registry-read-apis.md`
- `references/recipes/micro-rpc-message-loader.md`
- `references/recipes/new-project-scaffold.md`
- `references/recipes/queue-worker-idempotency.md`
- `references/recipes/redis-cache-singleflight.md`
- `references/recipes/rsc-plugin-host.md`
- `references/recipes/runtime-config.md`
- `references/recipes/stable-runtime-reload.md`

## Verification

When editing a Hile repo, prefer the repository commands. Common checks are:

```bash
pnpm run build
pnpm run test
```

For package publishing changes, dry-run pack representative packages and confirm `AI.md` ships with npm packages.
