# RSC Plugin Architecture

Packages: `@hile/rsc`, `@hile/rsc-build`, `@hile/rsc-development`, and `@hile/rsc-next`.

The packages form a one-way dependency graph:

- `@hile/rsc` owns only the transport-neutral protocol, verified artifacts, plugin/Host runtime, build leases, actions, transport ports, and client runtime boundary.
- `@hile/rsc-build` owns the production compiler, directive analysis, shared React build shim, configuration loader, and `hile-rsc` CLI.
- `@hile/rsc-development` owns persistent incremental compilation, file observation, immutable revision state, plugin/model reload, Host activation, SSE, browser reload, and `hile-rsc-dev`.
- `@hile/rsc-next` owns the Next-version-specific Flight decoder and is the only RSC package allowed to import Next private modules.

Dependencies point from adapters and tooling toward core; `@hile/rsc` never imports the other three packages.

## Copy-Paste Example

```ts
import { RscPluginService, createOfficialRscRenderer } from '@hile/rsc/plugin'
import { attachRscPluginService } from '@hile/rsc/transport'

const service = new RscPluginService({
  manifest,
  renderer: createOfficialRscRenderer(artifactRoot),
})
await service.load(fileURLToPath(new URL('../models', import.meta.url)))

const detach = attachRscPluginService(service, internalRegistrar)
shutdown(async () => {
  service.deactivate()
  await service.drain()
  detach()
})
```

The registrar may be a Hile `Server`, an in-process adapter, or another transport implementation. The plugin service itself creates no HTTP listener.

## More Examples

Build and verify an immutable plugin artifact:

```bash
hile-rsc build --config hile-rsc.json
hile-rsc inspect .hile-rsc/build-a
hile-rsc verify .hile-rsc/build-a \
  --react 19.2.8 --react-dom 19.2.8 --rsc 19.2.8
```

Compose a host runtime:

```ts
import { RscHostRuntime } from '@hile/rsc/host'

const runtime = new RscHostRuntime({
  locator,
  decoder,
})

const tree = await runtime.render({
  pluginId,
  request: { buildId, path, params, searchParams },
  signal,
})
```

Every route entry receives framework-owned `RscRouteProps`. The `rsc`
field is the exact immutable deployment identity selected for that render,
including development revision suffixes. Pass this serializable value into
`'use client'` boundaries that invoke actions; never copy the base build id
from configuration into browser code.

```tsx
import type { RscRouteProps } from '@hile/rsc/plugin'
import InteractiveBoundary from './interactive'

export function PluginPage({ rsc }: RscRouteProps) {
  return <InteractiveBoundary rsc={rsc} />
}
```

## Use When

- Plugins must be built, installed, activated, upgraded, and removed independently from the host Next build.
- One public `HttpNext` listener must own HTML, Next assets, plugin assets, and navigation responses.
- Plugin RSC generation belongs to internal microservices.
- Plugin-owned `'use client'` graphs need real SSR, hydration, hooks, context, effects, CSS, and lazy chunks.

## Do Not Use When

- A static Next application can include every route at host build time.
- A plugin is only JSON data or a small UI schema and does not need React code ownership.
- Each plugin is intentionally a separately deployed public web application.
- The plugin depends on unsupported Next-private APIs rather than React component boundaries.

## Install

Plugin build/runtime (does not install Next):

```bash
pnpm add @hile/rsc @hile/rsc-build @hile/model react@19.2.8 react-dom@19.2.8 react-server-dom-webpack@19.2.8
```

Host-only Next adapter:

```bash
pnpm add @hile/rsc @hile/rsc-next next@16.3.0 react@19.2.8 react-dom@19.2.8
```

React, React DOM, and the RSC runtime are exact compatibility pins.
Next exists only in `@hile/rsc-next`; plugin services and the core package do not install or evaluate it.
Start the plugin renderer with `NODE_OPTIONS=--conditions=react-server`; this is the official React server export condition and applies equally to production and development processes.

## Imports

```ts
import { buildRscPlugin } from '@hile/rsc-build'
import { RscPluginService } from '@hile/rsc/plugin'
import { createHileRscPluginClient } from '@hile/rsc/transport'
import { RscHostRuntime, InMemoryRscDeploymentCatalog } from '@hile/rsc/host'
import { RscClientRuntimeProvider } from '@hile/rsc/client'
import { verifyRscPluginArtifact } from '@hile/rsc/artifact'
import { decodePluginFlight } from '@hile/rsc-next'
```

## Incremental development

Production continues to use `buildRscPlugin()` and an empty immutable output directory. Development uses a separate long-lived compiler:

```ts
import { createRscDevelopmentCompiler } from '@hile/rsc-development/compiler'

const compiler = await createRscDevelopmentCompiler({
  ...config,
  cwd: pluginRoot,
  outdir: developmentRoot,
  sessionId: 'local-dev',
})

const revision = await compiler.rebuild()
// revision.artifactRoot is immutable and is published only after all targets succeed.
await compiler.dispose()
```

The server, browser, and SSR esbuild contexts are reused. Browser and SSR contexts are recreated only when the set of `'use client'` entries or their exports changes. Failed rebuilds leave the last successful revision intact.

`RscPluginService.activate()` switches new render requests to a verified manifest/renderer pair while in-flight requests finish on their captured revision. `RscPluginService.load()` atomically replaces the model snapshot; `bindRscModelDevelopment()` can watch model files without rebuilding RSC assets. The Host can compose `bindRscHostDevelopmentState()`, `createRscDevelopmentEventMiddleware()`, and `RscDevelopmentReload` so browser refresh happens only after the plugin namespace reports the matching build.

This development path performs full-page refresh after activation. It does not claim React Fast Refresh state preservation across independently compiled plugin boundaries.

The core package root exports only the transport-neutral protocol. Build, development, and Next-specific behavior are physically separate packages, so a production service that does not install them cannot evaluate their code or inherit their dependencies.

## Compose With

- `@hile/http-next` owns the only public HTTP/Next server and exposes request cancellation context.
- `@hile/micro` provides service discovery and internal RPC/streaming.
- `@hile/message-modem` provides cancellation and stream credit/backpressure.
- `@hile/message-ws` provides binary Flight frames when WebSocket is selected.
- `@hile/core` owns startup and graceful shutdown order.

## Runtime And Lifecycle Notes

- `protocol` is the stable manifest ABI and imports no runtime implementation.
- `plugin` receives the renderer and scans domain-organized models through `RscPluginService.load()`.
- Only `defineActionModel()` exports are mounted as actions; ordinary `defineModel()` exports remain internal.
- `transport` owns registrar/client/locator ports and optional Hile adapters.
- `host` composes build leases, artifact catalogs, action policy, and an injected Flight decoder.
- `@hile/rsc-next` is the isolated Next-private adapter. Keep every Next-version-specific import there.
- A request holds an exact build lease until its decoder consumes or closes the Flight stream. Activation moves new requests to the new build while old leases drain.
- Browser artifacts are immutable and integrity-checked before activation.
- The public asset middleware exposes only browser modules, browser chunks, styles, and a sanitized browser manifest; server and SSR artifacts remain internal.
- Internal stream requests negotiate protocol version 1. New peers use binary frames and per-chunk credit; rolling upgrades fall back to the legacy JSON stream when an older peer does not advertise the version.

## Anti-Patterns

- Creating `HttpNext`, Koa, Express, or another HTTP listener inside a plugin service.
- Importing Hile or Next implementations into `RscHostRuntime` instead of an adapter.
- Putting product routes, tenants, permission decisions, or domain state in `@hile/rsc`.
- Treating `'use server'` as the Server Component marker.
- Detecting `'use client'` with string search instead of directive-prologue AST parsing.
- Bundling a second React copy into plugin browser or SSR artifacts.
- Switching a mutable global build id while a request is streaming.
- Handwriting a second `actions` handler map or exposing ordinary models automatically.

## Verification Checklist

- `plugin.json` passes protocol and exact runtime validation.
- Every server, browser, SSR, chunk, and style artifact passes SHA-256 verification.
- Only the host owns a public TCP/HTTP listener.
- Real Flight bytes cross the internal transport with abort and backpressure.
- SSR HTML contains plugin client output before browser JavaScript runs.
- Hooks, context, effects, CSS, lazy imports, and interaction hydrate without console errors.
- Disconnect aborts the internal renderer.
- Old build requests finish during upgrade; new requests select the new build.
- Deactivated builds reject new leases and host routes map that state explicitly.
