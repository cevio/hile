---
name: hile
description: "Example-first AI development guide for Hile (@hile/* packages). Use when generating or editing code with @hile/core, @hile/http, @hile/http-next, @hile/model, @hile/context, @hile/typeorm, @hile/ioredis, @hile/cache, @hile/message-*, @hile/micro, Redis reliability packages, @hile/schedule, or create-hile."
---

# Hile AI Development Skill

This skill is optimized for AI coding agents, not for narrative documentation. Prefer examples, source-calibrated package boundaries, and verification checklists.

## Required Workflow

1. Read `references/package-map.md` and pick the package card or recipe that matches the user task.
2. Read `references/conventions.md` before writing code.
3. Start from the closest copy-paste example in `references/packages/*.md` or `references/recipes/*.md`.
4. Read `references/anti-patterns.md` before finalizing.
5. When README/MDX conflicts with source, tests, or `references/`, trust source/tests and update the docs.

## High-Risk Rules

- Do not call `loadService()` at module top level; call it inside boot services, controllers, models, handlers, or functions.
- Load `@hile/http` controllers before `http.listen()` in new code.
- `@hile/http` Zod validation validates only; parse again when the handler needs coerced data.
- `MessageModem._send()` and `Application.call()` return promises. Never append a secondary response getter.
- Redis lock, idempotency, rate limit, cache, and queue helpers are not exactly-once guarantees.
- Queue handlers and retryable HTTP/RPC handlers with side effects need idempotency or a stronger business uniqueness wall.

## Start Here

- Package chooser: `references/package-map.md`
- Global conventions: `references/conventions.md`
- Common failure modes: `references/anti-patterns.md`
- Full context for website or npm consumers: `llms-full.txt`
