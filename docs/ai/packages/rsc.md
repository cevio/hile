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
| `@hile/rsc-discovery-hile` | Host and plugin | Explicitly secured Hile publication, bounded stream-to-disk download, lifecycle composition | Public HTTP or application authorization |
| `@hile/rsc-next` | Host only | Decode Flight in the supported Next request context | Plugin compilation or domain behavior |

The packages form a one-way dependency graph:

- `@hile/rsc` owns only the transport-neutral protocol, verified artifacts, plugin/Host runtime, build leases, actions, transport ports, and client runtime boundary.
- `@hile/rsc-build` owns the shared directive-aware module graph, reference source generation, artifact assembly, production publication transaction, configuration loader, and `hile-rsc` CLI. Production and development compilation use the same graph and assembler instead of parallel implementations.
- `@hile/rsc-development` owns persistent incremental compilation, file observation, immutable revision state, plugin/model reload, Host activation, SSE, browser reload, and `hile-rsc-dev`.
- `@hile/rsc-discovery` owns transport-neutral candidate selection, failover, missing-service grace, and deployment retirement.
- `@hile/rsc-discovery-hile` owns signed or explicitly trusted-internal Registry announcements, message-streamed artifact transfer, resource bounds, and automatic Host deployment.
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
    generation: 0,
    artifactRoot,
    // Only use this mode when every peer able to reach the internal Micro mesh is trusted.
    authentication: { mode: 'trusted-internal' },
  },
})
await runtime.start()
shutdown(() => runtime.close())
```

`HileRscPluginRuntime` is the recommended Hile composition root. Use the lower-level transport attachment APIs only when implementing a non-Hile adapter. The plugin service creates an internal Micro listener, never an HTTP listener.

The matching Host uses `authorize: createTrustedInternalRscDiscoveryAuthorizer()`.
This removes discovery keys and signatures; it does not remove immutable artifact integrity
verification, generation ordering, transfer bounds, public HTTP authentication, or Server
Function authorization. Use the existing `{ keyId, secret }` publisher configuration with
`createHmacRscDiscoveryAuthorizer()` whenever an internal peer is outside the trust boundary.
Only the exact `trusted-internal` mode is accepted; misspelled modes or objects mixing the mode
with signing fields fail before listener registration or Registry publication.

When migrating a running HMAC deployment, upgrade the Host's `@hile/rsc-discovery` and
`@hile/rsc-discovery-hile` packages before any plugin starts publishing trusted-internal
announcements. New readers remain compatible with signed announcements, while older readers do
not understand the unsigned wire shape. After all Hosts are upgraded, plugin replicas may roll
independently without a shared discovery secret.

## More Examples

Build and verify an immutable plugin artifact:

```bash
pnpm exec hile-rsc build
pnpm exec hile-rsc inspect
pnpm exec hile-rsc verify
```

`buildId`, `outdir`, `runtime`, and `styles` are optional in `hile-rsc.json`. Without the first three, the CLI generates an immutable build ID, writes the artifact below `.hile-rsc`, and uses the compatibility tuple supported by the installed `@hile/rsc`. `RSC_BUILD_ID` provides an explicit deployment identity without coupling builds to Git. Explicit config values and the complete `verify --react ... --react-dom ... --rsc ...` tuple remain available for compatibility checks. `styles` accepts non-empty CSS paths or package export specifiers; relative paths must be explicit, such as `./src/theme.css`. The compiler content-hashes and deduplicates these build-scoped files before recording them in the immutable manifest.

`resolveRscPluginArtifact()` from `@hile/rsc/artifact` is the shared path resolver for either one artifact directory or a build root. It validates an optional explicit build ID, ignores development, hidden, incomplete, and corrupt candidates, and otherwise selects the newest internally valid artifact. `resolveVerifiedRscPluginArtifact()` additionally evaluates candidates against the supplied Host runtime and returns the selected root plus its reusable verification result; verification and plugin boot code should use this form to skip incompatible builds without hashing the selected artifact twice.

Compose a host runtime:

```ts
import { randomUUID } from 'node:crypto'
import { createExecutionContext } from '@hile/context'
import { RscHostRuntime } from '@hile/rsc/host'

const runtime = new RscHostRuntime({
  locator,
  decoder,
  verificationCache: new Map(),
  observe: (event) => metrics.record(event),
})

const tree = await runtime.render({
  context: createExecutionContext({ requestId: randomUUID() }),
  pluginId,
  request: { buildId, path, params, searchParams },
  signal,
  timeout: 30_000,
  idleTimeout: 10_000,
  window: 8,
})
```

`pluginId` accepts either one lowercase identifier such as `analytics` or a
lowercase namespaced identifier such as `org.example.analytics`.

Manifest route paths may contain named single-segment parameters such as
`/items/[itemId]`. Parameter names begin with an ASCII letter and continue with
ASCII letters, digits, or underscores. The runtime adds captured values to
`RscRouteProps.params`; an existing caller-supplied parameter with the same name
fails closed. Exact routes take precedence over parameterized routes, then the
route with more static segments wins. Manifest validation rejects repeated
parameter names and equal-specificity patterns that can match the same path.
Presentation metadata navigation must reference a declared static route because
a parameter pattern does not identify a concrete destination.

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

### Client navigation

Remote plugins do not import Next. Render `RscLink` directly from a Server or Client Component
when a same-origin destination should use the public Host router:

```tsx
import { RscLink } from '@hile/rsc/client/navigation'

export function PluginPage() {
  return <RscLink href="/plugins/catalog/details">Details</RscLink>
}
```

For imperative navigation inside a Client Component, call `useRscNavigation()` and use its
`push`, `replace`, `refresh`, or `prefetch` operation. This is a framework-neutral browser port:
`RscNextClientRuntime` installs the Next implementation, while another Host may install a
different adapter. `RscLink` preserves native behavior for modifier keys, downloads, non-self
targets, external URLs, and consumer-cancelled events. Before the Host adapter hydrates, an
ordinary link remains a native anchor; imperative operations fall back to browser navigation.
Imperative destinations accept only HTTP(S) URLs, and cross-origin `push` or `replace` uses a
full browser navigation instead of passing an untrusted URL to the framework router.

Plugin browser graphs may import only `@hile/rsc/client/navigation` from `@hile/rsc`; Host,
transport, artifact, and general client-runtime imports fail during artifact compilation. Never
append `_rsc` or construct Flight headers in a plugin. The framework adapter owns navigation,
and Next generates its private RSC request.

### Suspense ownership

`RscClientRuntimeProvider` defaults to `suspensePolicy="remote"`, which gives every remote
Client Boundary its own fallback and enables the Host-owned `renderLoading` callback. This is
the backward-compatible choice for independently revealed plugin regions.

Use `suspensePolicy="host"` when the surrounding Host must coordinate those remote boundaries:

```tsx
<Suspense fallback={<span>Loading initial route…</span>}>
  <RscClientRuntimeProvider
    assetMountPath={assetMountPath}
    suspensePolicy="host"
  >
    {children}
  </RscClientRuntimeProvider>
</Suspense>
```

Host ownership propagates remote lazy-module and precedence-stylesheet suspension to the nearest
ancestor Suspense boundary. To retain a previously revealed page during navigation, keep that
ancestor boundary mounted above changing route content and use a transition-aware router such as
the Next adapter. The Host boundary defines cold-entry fallback behavior; nested Suspense
boundaries declared by plugin UI retain their own reveal sequence. Do not pass `renderLoading`
in `host` mode. `renderError(error, identity, retry)` remains available in both modes.

### Immutable plugin presentation metadata

An RSC plugin may declare optional Host-agnostic presentation metadata in its immutable manifest. `displayName`, `description`, and navigation labels are bounded display strings. Navigation IDs are stable plugin-local identifiers, and every navigation `path` must match a declared plugin route. The Host still owns public URL composition, authorization, visibility, ordering overrides, localization policy, and the rendered component library.

Metadata is carried by `plugin.json`, not duplicated into a discovery announcement. It therefore changes only with a new `buildId` (or development revision) and activates or rolls back atomically with the plugin code and routes. Legacy manifests without metadata remain valid and render normally.

Derive a catalog view from the existing active deployment and artifact catalogs:

```ts
import { listActiveRscPlugins } from '@hile/rsc/host/plugin-metadata'

const activePlugins = listActiveRscPlugins(deployments, artifacts)
```

`listActiveRscPlugins()` retains no second inventory. It fails closed if lifecycle state claims a deployment is active but its matching immutable manifest is absent. Consumers receive defensive values and may filter or project them into Host navigation without querying Registry on each request.

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
import { listActiveRscPlugins } from '@hile/rsc/host/plugin-metadata'
import { RscClientRuntimeProvider } from '@hile/rsc/client'
import { RscLink, useRscNavigation } from '@hile/rsc/client/navigation'
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

The server, browser, and SSR esbuild contexts are reused. Browser and SSR contexts are recreated only when the set of `'use client'` entries or their exports changes. Server-only edits reuse emitted browser/SSR artifacts when their input fingerprint and the Server Function graph are unchanged; build-scoped Server Function graphs rebuild client artifacts conservatively. Build-scoped `styles` are reassembled into every immutable development revision even when the browser graph is cached. Relative styles inside `cwd` participate in source observation; package-export or absolute styles require an explicit rebuild or config reload after their external source changes. Failed rebuilds leave the last successful revision intact. Development output retention is bounded per session and across stale sessions; keep at least two revisions and size `maxRevisions` for the maximum activation/download overlap your environment permits. The mutable `.work/<session>` directory is removed on compiler disposal.

`HileRscPluginRuntime` is the reusable Hile composition root for a plugin process. It owns transport attachment, the internal listener, explicitly secured discovery registration, optional development binding, auxiliary watcher cleanup, renderer drain, and rollback. Plugin packages provide declarative namespace/port/trust/artifact configuration; they do not duplicate lifecycle ordering.

## Server Functions

A plugin-owned module-level `'use server'` directive creates immutable, build-scoped Server Function references. Client Components import those functions normally and may pass them to React `useActionState` or a form `action`. The browser sends one same-origin POST to the Host; the Host authorizes it, resolves the exact `{ pluginId, buildId }` lease, and forwards the invocation through the internal RSC transport to the plugin microservice.

Server Functions are UI adapters, not another domain layer. Define them with `defineRscServerFunction(async (api, ...args) => ...)`: Hile hides `api` from the public React call signature, then supplies that explicit request-scoped capability at runtime. Call an automatically loaded `defineActionModel()` with `api.invokeModel()`; the API also carries the request `signal` and `context`, without module-level ambient state. Inline closure-capturing `'use server'` functions, ordinary unwrapped async exports, re-exports, synchronous exports, mixed `'use client'`/`'use server'` modules, and external dependency-owned `'use server'` modules fail at compile time. Arguments and return values use the RSC tagged wire codec, including `FormData`, dates, maps, sets, bigint, typed arrays, and promises; unsupported functions, class instances, non-global symbols, cyclic data, non-canonical binary encodings, and values outside configured depth/node/string/binary limits fail closed.

### Do not confuse the two action paths

| Path | Intended use | Browser API | Domain execution |
|---|---|---|---|
| React Server Function | Preferred for new plugin UI behavior | Import a `defineRscServerFunction()` export from a module-level `'use server'` file; call it, pass it as `formAction`, or use `useActionState` | The definition callback receives `RscServerFunctionApi` first and calls `api.invokeModel(actionId, input)`; the target must be a scanned `defineActionModel()` |
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
- A module-level `'use server'` marks `defineRscServerFunction()` exports as build-scoped Server Functions. Ordinary async exports and Next's inline closure-capturing form are intentionally rejected.
- Directive recognition parses the JavaScript directive prologue; it is not a substring or regular-expression check.
- Imported CSS is emitted as integrity-declared plugin assets. CSS Modules and library CSS that esbuild can bundle follow the same path.
- Large shared or generated styles that should exist once per plugin build may be declared through `hile-rsc.json` `styles` instead of importing them from every client boundary. Package CSS exports are resolved from the plugin project, copied into the immutable artifact, deduplicated by content, and listed before client-graph CSS. These files must be self-contained; relative `url()` dependencies and external `@import` files are not copied or rewritten by this raw static-style path.
- CSS-in-JS libraries that require an SSR collector must be composed at the correct owner. The Host owns its outer layout collector; a plugin owns providers inside its client boundary. Never create a second React runtime or assume a plugin can mutate the Host document head outside the declared asset/provider contracts.

The semantic baseline for Server Functions is the official [Next.js `use server` reference](https://nextjs.org/docs/app/api-reference/directives/use-server), [Next.js forms guide](https://nextjs.org/docs/app/guides/forms), and [React `useActionState` reference](https://react.dev/reference/react/useActionState). Those documents describe framework behavior; Hile deliberately supports the module-level async-export subset listed above and routes it through the independent plugin build/transport instead of Next's application compiler.

`RscPluginService.activate()` switches new render requests to a verified manifest/renderer pair while in-flight requests finish on their captured revision. `RscPluginService.load()` atomically replaces the model snapshot; `bindRscModelDevelopment()` can watch model files without rebuilding RSC assets. The plugin updates its discovery announcement only after activation; `HileRscDiscoveryHost` authorizes, downloads, and enables that revision, then the Host may compose `createRscDevelopmentEventMiddleware()` and `RscDevelopmentReload` for browser refresh.

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
- Flight streams accept `window` from 1 through 64 (default 1 for legacy peers), a total `timeout`, and an `idleTimeout` that resets after each valid chunk. Timeout and consumer cancellation send ABORT to the producer.
- `RscHostRuntime` shares immutable manifest verification only when a locator supplies a stable concrete-endpoint `verificationKey`; unkeyed or dynamically routed leases are verified on every render. It emits one non-blocking observer event per render with identity, outcome, duration, bytes, and optional error.
- Browser manifest/lazy-component caches and Host asset-metadata caches are bounded LRU caches. Rejected browser manifest requests are evicted, and immutable `{pluginId, buildId}` is the cache identity.
- Each client reference declares only browser and SSR chunks reachable from its own esbuild output graph; shared chunks remain shared without attaching unrelated lazy chunks.
- Registry manifests and all declared artifacts use the same bounded internal stream path and are piped directly to isolated files; the downloader does not buffer artifact bodies in memory.
- New publishers include a non-negative monotonic `generation` (default 0) and increment it on each immutable build update; HMAC mode signs it. The discovery manager keeps a fail-closed high-water mark per trust identity, plugin, and instance: changed content must use a strictly higher generation, and an identity retired after the missing threshold is tombstoned so the same payload cannot resurrect it. Pass a caller-owned `generationHighWater` map through `HileRscDiscoveryHost` when the history must survive manager or Host replacement; the generated Host keeps one module-level store. A store has one live owner: close the old Host successfully before handing it to its replacement.
- Generation history has a fail-closed capacity (default 4096 identities), including caller-owned stores. Reaching the limit rejects new identities instead of evicting replay history.
- Registry snapshot reads default to 16 concurrent topic reads and accept a validated `snapshotConcurrency` up to 64 while preserving deterministic topic order.
- The Host always requires an explicit `authorize` policy before artifact download or activation. HMAC mode must bind its `keyId` to an explicit allowlist of plugin IDs. `trusted-internal` accepts unsigned announcements and is correct only when every service able to reach the internal Hile Micro mesh is trusted to publish any plugin identity. During an HMAC rolling upgrade, legacy generation-less announcements remain verifiable; after every publisher is upgraded, set `requireGeneration: true` to prevent field-stripping downgrade.
- Registry presence is the liveness source of truth. HMAC plus generation detects modification and rollback, but an exact replay of the currently accepted announcement is intentionally indistinguishable from a healthy retained topic. `trusted-internal` additionally assumes Registry writers are trusted. Deployments requiring an adversarial-Registry threat model need a separate signed freshness/attestation layer.
- `HileRscDiscoveryHost` exposes bounded transfer settings: `maxManifestBytes`, `maxFileBytes`, `maxTotalBytes`, `maxArtifactFiles`, `maxPathBytes`, `maxPathDepth`, and `operationTimeoutMs`. Configure them for the deployment environment instead of assuming defaults are an application quota.
- `@hile/rsc-next` validates the installed Next 16.3.0 + React 19.2.8 + React DOM 19.2.8 package tuple before decoding through its isolated Next-private modules. These peer dependencies are intentionally exact, not ranges.
- `RscClientRuntimeProvider` defaults to `suspensePolicy="remote"`: every remote Client Boundary owns a local Suspense fallback and may use Host-owned `renderLoading`. Set `suspensePolicy="host"` to propagate remote module and stylesheet suspension to the nearest Host-owned Suspense boundary; this mode rejects `renderLoading` because no remote fallback is rendered.
- For navigation that retains the previous page until the delegated remote boundaries are ready, mount the Host-owned Suspense boundary above changing route content and keep it stable across navigations. A Suspense-enabled router transition can then preserve already revealed content and commit that coordinated region together. `suspensePolicy="host"` delegates suspension ownership; it does not manufacture retained content when the Host remounts the boundary or performs an urgent update, and plugin-owned nested Suspense boundaries keep their own reveal sequence.
- Define Host loading and error functions inside a Host Client Component so they never cross the RSC serialization boundary. `renderError(error, identity, retry)` remains per remote boundary under both Suspense policies.
- `RscNextClientRuntime` installs the browser navigation adapter for remote `RscLink` and `useRscNavigation()` calls. It does not expose Next to plugin packages or generate `_rsc` itself.
- Hile does not enable cross-request Next Cache/revalidation for rendered plugin trees. Tenant/user-specific RSC caching is an application policy and requires an explicit safe cache key and invalidation design.

## Anti-Patterns

- Creating `HttpNext`, Koa, Express, or another HTTP listener inside a plugin service.
- Importing Hile or Next implementations into `RscHostRuntime` instead of an adapter.
- Putting product routes, tenants, permission decisions, or domain state in `@hile/rsc`.
- Treating `'use server'` as the Server Component marker.
- Detecting `'use client'` with string search instead of directive-prologue AST parsing.
- Bundling a second React copy into plugin browser or SSR artifacts.
- Importing Next, `@hile/rsc/client`, or Host/transport RSC APIs from a remote Client Component; use only `@hile/rsc/client/navigation` for browser navigation.
- Passing `renderLoading` with `suspensePolicy="host"`, or claiming Host-owned suspension retains old content without a stable ancestor Suspense boundary and a transition-aware router update.
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
