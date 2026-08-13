# test-rsc-demo-suite

Private orchestration and acceptance package for the complete Hile RSC Demo topology. It is intentionally not publishable.

## Topology

| Package | Role | Listener |
|---|---|---|
| `test-rsc-host` | The only public Next/HTML/assets/Server Function endpoint | HTTP `3200`, internal micro `4210` |
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

Each successful build is published as an immutable revision. The plugin microservice switches renderer first and
updates its Registry capability. The Host discovers it, downloads declared artifacts through internal Hile message
streams, verifies the complete artifact, atomically enables it, and then emits an SSE event. A failed build keeps
the previous page usable and leaves the watcher alive. Model changes use the service's atomic model loader and do
not invoke the RSC compiler. If port `9876` is free, the demo starts and owns a development Registry; an existing
Registry is reused and never stopped by the demo.

This demonstrates incremental rebuild and safe activation, not React Fast Refresh state preservation.

## Run automated acceptance

```bash
pnpm --filter test-rsc-demo-suite test:contracts
pnpm --filter test-rsc-demo-suite test:e2e
```

The E2E suite proves raw HTML SSR, browser hydration, hooks/context/state, CSS, lazy chunks, module-level `'use server'`, `useActionState`, Server Function → model execution over the internal microservice transport, plugin isolation, Registry activation, and server-artifact non-exposure.

`pnpm --filter test-rsc-demo-suite test:e2e:dev` additionally mutates a real plugin source: it proves a broken incremental build keeps the previous deployment serving, then verifies the repaired revision is compiled, announced, downloaded, activated, and rendered by the browser.

## Run pieces separately

Build and start each plugin first, then start the Host:

```bash
pnpm --filter test-rsc-plugin-capabilities-v1 build && pnpm --filter test-rsc-plugin-capabilities-v1 start
pnpm --filter test-rsc-plugin-capabilities-v2 build && pnpm --filter test-rsc-plugin-capabilities-v2 start
pnpm --filter test-rsc-plugin-isolation build && pnpm --filter test-rsc-plugin-isolation start
pnpm --filter test-rsc-host build && pnpm --filter test-rsc-host start
```

Each actual Demo package uses `.env` and `.env.prod`. The `_env` filename exists only inside create-hile template sources, where the generator later renames it.
