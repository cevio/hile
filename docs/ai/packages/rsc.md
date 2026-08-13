# RSC Plugin Architecture

Packages: `@hile/rsc`, `@hile/rsc-build`, `@hile/rsc-development`, `@hile/rsc-discovery`, `@hile/rsc-discovery-hile`, and `@hile/rsc-next`.

## AI Reading Contract

This page is the authoritative architecture and API-selection reference. To implement a working system, read it together with `recipes/rsc-plugin-host.md`; that recipe is the authoritative scaffold-first configuration, startup, development, and verification guide. A blank-directory reimplementation of boot orchestration is not the supported quick start: generate the maintained Host and plugin templates, then customize their explicit composition points. The maintained executable references are:

- `packages/create-hile/templates/rsc-plugin` for the smallest reusable plugin service;
- `packages/create-hile/templates/rsc-host` for the smallest single-endpoint Host;
- `packages/test-rsc-demo-suite` for production and development orchestration;
- `packages/test-rsc-plugin-capabilities-v2` for module-level `'use server'`, `useActionState`, Ant Design, CSS, and Model invocation;
- `packages/test-rsc-host` for the outer Next layout, automatic discovery, middleware, Flight decoding, and browser runtime.

Do not invent another public plugin endpoint, static plugin inventory, manual activation API, mutable build directory, action-handler map, or Next-private decoder. If an example conflicts with this page, the recipe, or the current templates, use those sources in that order and report the conflict.

## Package Selection

| Package | Install in | Responsibility | Must not own |
|---|---|---|---|
| `@hile/rsc` | Host and plugin | Protocol, artifacts, render/action transport, leases, client boundary | Next-specific decoding, watchers, Registry policy |
| `@hile/rsc-build` | Plugin build tooling | Directive graph, esbuild compilation, immutable artifact and CLI | Runtime listener or development watcher |
| `@hile/rsc-development` | Development-only Host/plugin tooling | Incremental contexts, immutable revisions, model reload, SSE reload | Production deployment policy |
| `@hile/rsc-discovery` | Host lifecycle layer | Transport-neutral selection, failover, grace, retirement | Hile Registry or filesystem I/O |
| `@hile/rsc-discovery-hile` | Host and plugin | Signed Hile publication, bounded stream-to-disk download, lifecycle composition | Public HTTP or application authorization |
| `@hile/rsc-next` | Host only | Decode Flight in the supported Next request context | Plugin compilation or domain behavior |

The packages form a one-way dependency graph:

- `@hile/rsc` owns only the transport-neutral protocol, verified artifacts, plugin/Host runtime, build leases, actions, transport ports, and client runtime boundary.
- `@hile/rsc-build` owns the shared directive-aware module graph, reference source generation, artifact assembly, production publication transaction, configuration loader, and `hile-rsc` CLI. Production and development compilation use the same graph and assembler instead of parallel implementations.
- `@hile/rsc-development` owns persistent incremental compilation, file observation, immutable revision state, plugin/model reload, Host activation, SSE, browser reload, and `hile-rsc-dev`.
- `@hile/rsc-discovery` owns transport-neutral candidate selection, failover, missing-service grace, and deployment retirement.
- `@hile/rsc-discovery-hile` owns signed Registry announcements, message-streamed artifact transfer, resource bounds, and automatic Host deployment.
- `@hile/rsc-next` owns the Next-version-specific Flight decoder and is the only RSC package allowed to import Next private modules.

Dependencies point from adapters and tooling toward core; `@hile/rsc` never imports the other packages.

## Copy-Paste Example

```ts
import { RscArtifactServerFunctionRuntime, RscPluginService, createOfficialRscRenderer } from '@hile/rsc/plugin'
import { HileRscPluginRuntime } from '@hile/rsc-discovery-hile'

const service = new RscPluginService({
  manifest,
  renderer: createOfficialRscRenderer(artifactRoot),
  serverFunctions: new RscArtifactServerFunctionRuntime(artifactRoot),
})
await service.load(fileURLToPath(new URL('../models', import.meta.url)))

const runtime = new HileRscPluginRuntime({
  application,
  service,
  port: internalMicroPort,
  discovery: {
    namespace,
    instanceId,
    priority: 0,
    artifactRoot,
    authentication: { keyId, secret },
  },
})
await runtime.start()
shutdown(() => runtime.close())
```

`HileRscPluginRuntime` is the recommended Hile composition root. Use the lower-level transport attachment APIs only when implementing a non-Hile adapter. The plugin service creates an internal Micro listener, never an HTTP listener.

## More Examples

Build and verify an immutable plugin artifact:

```bash
pnpm exec hile-rsc build --config hile-rsc.json
pnpm exec hile-rsc inspect .hile-rsc/build-a
pnpm exec hile-rsc verify .hile-rsc/build-a \
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
pnpm add @hile/cli @hile/core @hile/micro @hile/model @hile/rsc @hile/rsc-discovery-hile react@19.2.8 react-dom@19.2.8 react-server-dom-webpack@19.2.8
pnpm add -D @hile/rsc-build @hile/rsc-development
```

Host-only Next adapter:

```bash
pnpm add @hile/cli @hile/core @hile/http-next @hile/micro @hile/rsc @hile/rsc-discovery-hile @hile/rsc-next next@16.3.0 react@19.2.8 react-dom@19.2.8
pnpm add -D @hile/rsc-development
```

React, React DOM, and the RSC runtime are exact compatibility pins.
Next-private RSC decoding exists only in `@hile/rsc-next`; plugin services and transport-neutral RSC packages do not install or evaluate Next. The Host application itself installs Next and may use public Next APIs in its routes and layout.
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
import { RscNextClientRuntime } from '@hile/rsc-next/client'
import { RscDiscoveryManager } from '@hile/rsc-discovery'
import { HileRscDiscoveryHost, registerHileRscPluginDiscovery } from '@hile/rsc-discovery-hile'
import { HileRscPluginRuntime } from '@hile/rsc-discovery-hile'
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
  maxRevisions: 5,
  maxSessions: 3,
})

const revision = await compiler.rebuild()
// revision.artifactRoot is immutable and is published only after all targets succeed.
await compiler.dispose()
```

The server, browser, and SSR esbuild contexts are reused. Browser and SSR contexts are recreated only when the set of `'use client'` entries or their exports changes. Server-only edits reuse emitted browser/SSR artifacts when their input fingerprint and the Server Function graph are unchanged; build-scoped Server Function graphs rebuild client artifacts conservatively. Failed rebuilds leave the last successful revision intact. Development output retention is bounded per session and across stale sessions; keep at least two revisions and size `maxRevisions` for the maximum activation/download overlap your environment permits. The mutable `.work/<session>` directory is removed on compiler disposal.

`HileRscPluginRuntime` is the reusable Hile composition root for a plugin process. It owns transport attachment, the internal listener, signed discovery registration, optional development binding, auxiliary watcher cleanup, renderer drain, and rollback. Plugin packages provide declarative namespace/port/credential/artifact configuration; they do not duplicate lifecycle ordering.

## Server Functions

A plugin-owned module-level `'use server'` directive creates immutable, build-scoped Server Function references. Client Components import those functions normally and may pass them to React `useActionState` or a form `action`. The browser sends one same-origin POST to the Host; the Host authorizes it, resolves the exact `{ pluginId, buildId }` lease, and forwards the invocation through the internal RSC transport to the plugin microservice.

Server Functions are UI adapters, not another domain layer. Call an automatically loaded `defineActionModel()` with `invokeRscModel()` inside the Server Function. Inline closure-capturing `'use server'` functions, re-exports, synchronous exports, mixed `'use client'`/`'use server'` modules, and external dependency-owned `'use server'` modules fail at compile time. Arguments and return values use the RSC tagged wire codec, including `FormData`, dates, maps, sets, bigint, typed arrays, and promises; unsupported functions, class instances, non-global symbols, cyclic data, non-canonical binary encodings, and values outside configured depth/node/string/binary limits fail closed.

### Do not confuse the two action paths

| Path | Intended use | Browser API | Domain execution |
|---|---|---|---|
| React Server Function | Preferred for new plugin UI behavior | Import an async export from a module-level `'use server'` file; call it, pass it as `formAction`, or use `useActionState` | Call `invokeRscModel(actionId, input)`; the target must be a scanned `defineActionModel()` |
| Direct RSC Action Gateway | Lower-level compatibility/infrastructure integration | Explicit action POST through `RscActionGateway` | Resolves the same action-model registry, but does not provide React Server Function semantics |

The word “Server Action” in React/Next documentation describes a Server Function used for mutations or forms. In this architecture, use the broader and less ambiguous term **Server Function** for the `'use server'` path.

### Model scanning contract

- Call `await service.load(modelsDirectory)` before `runtime.start()`.
- Files are discovered through `@hile/loader`; their default export must be a valid `@hile/model` definition.
- Only `defineActionModel()` is browser-callable. `defineModel()` remains private to the service.
- The action ID is the relative model path without `.model` and extension: `account/update.model.ts` becomes `account/update`.
- Model pipelines, services, validation, cancellation context, and other `@hile/model` behavior remain available because execution goes through the Model abstraction.
- Development model changes use `bindRscModelDevelopment()` and atomically replace the model snapshot without rebuilding RSC assets.

## Directive And Styling Contract

- A plugin component is a Server Component by default; it does not need `'use server'`.
- A module-level `'use client'` marks the client boundary. Its transitive browser graph is built by the shared custom directive graph and esbuild pipeline, SSR-rendered with the Host React runtime, then hydrated from immutable same-origin assets.
- A module-level `'use server'` marks all supported async exports as build-scoped Server Functions. This implementation intentionally does not support Next's inline closure-capturing form.
- Directive recognition parses the JavaScript directive prologue; it is not a substring or regular-expression check.
- Imported CSS is emitted as integrity-declared plugin assets. CSS Modules and library CSS that esbuild can bundle follow the same path.
- CSS-in-JS libraries that require an SSR collector must be composed at the correct owner. The Host owns its outer layout collector; a plugin owns providers inside its client boundary. Never create a second React runtime or assume a plugin can mutate the Host document head outside the declared asset/provider contracts.

The semantic baseline for Server Functions is the official [Next.js `use server` reference](https://nextjs.org/docs/app/api-reference/directives/use-server), [Next.js forms guide](https://nextjs.org/docs/app/guides/forms), and [React `useActionState` reference](https://react.dev/reference/react/useActionState). Those documents describe framework behavior; Hile deliberately supports the module-level async-export subset listed above and routes it through the independent plugin build/transport instead of Next's application compiler.

`RscPluginService.activate()` switches new render requests to a verified manifest/renderer pair while in-flight requests finish on their captured revision. `RscPluginService.load()` atomically replaces the model snapshot; `bindRscModelDevelopment()` can watch model files without rebuilding RSC assets. The plugin updates its signed discovery announcement only after activation; `HileRscDiscoveryHost` downloads and enables that revision, then the Host may compose `createRscDevelopmentEventMiddleware()` and `RscDevelopmentReload` for browser refresh.

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
- `plugin` receives the renderer and immutable Server Function runtime, then scans domain-organized models through `RscPluginService.load()`.
- Only `defineActionModel()` exports are mounted as actions; ordinary `defineModel()` exports remain internal.
- `transport` owns registrar/client/locator ports and optional Hile adapters.
- `host` composes build leases, artifact catalogs, action policy, and an injected Flight decoder.
- `@hile/rsc-next` is the isolated Next-private adapter. Keep every Next-version-specific import there.
- A request holds an exact build lease until its decoder consumes or closes the Flight stream. Activation moves new requests to the new build while old leases drain.
- Browser artifacts are immutable and integrity-checked before activation.
- The public asset middleware exposes only browser modules, browser chunks, styles, and a sanitized browser manifest; server and SSR artifacts remain internal.
- Internal stream requests require protocol version 1 and per-chunk credit. Unsupported uncredited streams fail closed instead of disabling backpressure.
- Registry manifests and all declared artifacts use the same bounded internal stream path and are piped directly to isolated files; the downloader does not buffer artifact bodies in memory.
- Registry discovery is not authorization. Every announcement is signed, and the Host must supply a fail-closed `authorize` policy before artifact download or activation. An HMAC credential must bind its `keyId` to an explicit allowlist of plugin IDs; sharing a secret without publisher-to-plugin ownership does not establish authorization.
- `HileRscDiscoveryHost` exposes bounded transfer settings: `maxManifestBytes`, `maxFileBytes`, `maxTotalBytes`, `maxArtifactFiles`, `maxPathBytes`, `maxPathDepth`, and `operationTimeoutMs`. Configure them for the deployment environment instead of assuming defaults are an application quota.

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
- Every server, Server Function, browser, SSR, chunk, and style artifact passes SHA-256 verification.
- Only the host owns a public TCP/HTTP listener.
- Real Flight bytes cross the internal transport with abort and backpressure.
- SSR HTML contains plugin client output before browser JavaScript runs.
- Hooks, context, effects, CSS, lazy imports, and interaction hydrate without console errors.
- Disconnect aborts the internal renderer.
- Old build requests finish during upgrade; new requests select the new build.
- Deactivated builds reject new leases and host routes map that state explicitly.
- A fresh reader can scaffold and start Registry, plugin, and Host using the recipe; no implicit static inventory or manual activation is required.
- A Client Component can submit a module-level Server Function, which authorizes at the Host and executes a scanned action model in the exact plugin build.
- Host CSS/layout remains outside the plugin tree while plugin CSS and component-library behavior render and hydrate inside it.
