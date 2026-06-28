# create-hile

Package: `create-hile`.

## Copy-Paste Example

Create a project:

```bash
npx create-hile create my-app
cd my-app
pnpm install
pnpm run dev
```

Skip dependency install:

```bash
npx create-hile create my-app --skip-install
```

## More Examples

Template choices:

```text
default          HTTP API with @hile/http
next             Next.js + Hile controllers on one port
micro-http       Microservice plus HTTP endpoint
micro            Pure microservice
micro-http-next  Next.js + microservice + HTTP
monorepo         Lerna + pnpm workspace
```

Generated default HTTP shape:

```text
src/
  controllers/
    index.controller.ts
  services/
    index.boot.ts
```

## Use When

Use `create-hile` when starting a new Hile application or workspace.

## Do Not Use When

- Do not use generated templates as the final architecture for complex apps without introducing models, services, and context boundaries.
- Do not trust stale template README files if they mention unrelated application domains; regenerate or rewrite them from current template files.

## Install

Usually no install is needed:

```bash
npx create-hile create my-app
```

## Imports

The CLI entrypoint exports a `create` command. Application code does not import `create-hile`.

## Compose With

- Generated apps use `@hile/cli` for `hile start`.
- HTTP templates use `@hile/core` and `@hile/http`.
- Next templates use `@hile/http-next` and `@hile/model`.
- Micro templates use `@hile/micro` and `@hile/message-loader`.

## Runtime And Lifecycle Notes

- Templates use `_env`, `_env.prod`, and `_gitignore`; creation renames them to dotfiles.
- The CLI prompts for a template and optional dependency installation.
- The package manager preference is `pnpm`, then `yarn`, then `npm`.

## Anti-Patterns

- Leaving template package versions stale after publishing new Hile packages.
- Shipping template READMEs copied from unrelated projects.
- Starting production without running the build command required by the selected template.

## Verification Checklist

- New project has `"type": "module"`.
- Dev script runs `hile start --dev`.
- Production script runs `hile start` after build.
- Boot files default-export `defineService(...)`.
