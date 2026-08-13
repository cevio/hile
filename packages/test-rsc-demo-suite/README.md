# test-rsc-demo-suite

Private orchestration and acceptance package for the complete Hile RSC Demo topology. It is intentionally not publishable.

## Topology

| Package | Role | Listener |
|---|---|---|
| `test-rsc-host` | The only public Next/HTML/assets/actions endpoint | HTTP `3200`, internal micro `4210` |
| `test-rsc-plugin-capabilities-v1` | Initial immutable plugin build | internal micro `4211` |
| `test-rsc-plugin-capabilities-v2` | Replacement build for runtime activation | internal micro `4212` |
| `test-rsc-plugin-isolation` | Independent plugin identity and client graph | internal micro `4213` |
| `test-rsc-demo-suite` | Builds, starts, verifies and stops the topology | none |

All services discover each other through the already-running registry at `127.0.0.1:9876`.

## Run interactively

From the repository root:

```bash
pnpm --filter test-rsc-demo-suite demo
```

Open:

- `http://127.0.0.1:3200/` — topology and deployment lifecycle controls;
- `http://127.0.0.1:3200/plugins/demo.rsc.capabilities?label=review&count=3` — full Server/Client capability graph;
- `http://127.0.0.1:3200/plugins/demo.rsc.capabilities/details?source=review` — server-only plugin route;
- `http://127.0.0.1:3200/plugins/demo.rsc.isolation?marker=review` — independent plugin.

Press Ctrl-C to stop only the four processes owned by the suite.

## Run in development mode

```bash
pnpm --filter test-rsc-demo-suite dev
```

The Host runs through the native Next/Hile development path. Each plugin owns a persistent incremental compiler session. Changes under that plugin's `src/plugin/` tree rebuild only its server, browser and SSR graphs; warm edits reuse all three esbuild contexts, while a changed `'use client'` boundary set recreates only the browser and SSR contexts.

Each successful build is published as an immutable revision. The plugin microservice switches renderer first, the Host verifies the artifact and waits for the same `buildId`, then activates its catalogs and emits an SSE event. The browser performs a full-page refresh only after that sequence completes. A failed build keeps the previous page usable and leaves the watcher alive. Model changes use the service's atomic model loader and do not invoke the RSC compiler. The registry on `9876` is never stopped or replaced.

This demonstrates incremental rebuild and safe activation, not React Fast Refresh state preservation.

## Run automated acceptance

```bash
pnpm --filter test-rsc-demo-suite test:contracts
pnpm --filter test-rsc-demo-suite test:e2e
```

The E2E suite proves raw HTML SSR, browser hydration, hooks/context/state, CSS, lazy chunks, internal actions, plugin isolation, runtime v1→v2 activation, deactivation/404/reactivation, and server-artifact non-exposure.

## Run pieces separately

Build and start each plugin first, then start the Host:

```bash
pnpm --filter test-rsc-plugin-capabilities-v1 build && pnpm --filter test-rsc-plugin-capabilities-v1 start
pnpm --filter test-rsc-plugin-capabilities-v2 build && pnpm --filter test-rsc-plugin-capabilities-v2 start
pnpm --filter test-rsc-plugin-isolation build && pnpm --filter test-rsc-plugin-isolation start
pnpm --filter test-rsc-host build && pnpm --filter test-rsc-host start
```

Each actual Demo package uses `.env` and `.env.prod`. The `_env` filename exists only inside create-hile template sources, where the generator later renames it.
