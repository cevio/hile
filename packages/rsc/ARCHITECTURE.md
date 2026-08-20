# @hile/rsc architecture

## Physical package boundaries

- `@hile/rsc`: stable protocol and runtime mechanisms only.
- `@hile/rsc-build`: production artifact compiler and CLI; depends on core.
- `@hile/rsc-development`: optional incremental compiler and reload coordination; depends on core and build.
- `@hile/rsc-discovery`: transport-neutral discovery selection and lifecycle policy; depends only on discovery contracts.
- `@hile/rsc-discovery-hile`: Registry and message-stream adapter; depends on discovery and core RSC contracts.
- `@hile/rsc-next`: optional Next Flight decoder; depends on core.

Core has no dependency on esbuild, TypeScript, filesystem watchers, EventSource development code, Registry, Hile transport, or Next. Removing all optional adapter/tooling packages must leave core production behavior unchanged.

## Invariants

1. Exactly one public HTTP/Next runtime owns HTML, RSC navigation responses, `/_next`, plugin assets, and optional action endpoints.
2. Plugin runtimes generate official React Flight internally and never create an HTTP listener.
3. A plugin is compiled independently and its registered microservice is automatically enabled without rebuilding
   the host Next build.
4. Every request is pinned to one immutable `{ pluginId, buildId }` until the decoder consumes or closes the Flight stream.
5. A `'use client'` directive defines a transitive client graph. The graph shares the host React singleton and hydrates from the same host origin.
6. A module-level `'use server'` directive defines build-scoped Server Functions. The Host authorizes one same-origin endpoint and forwards execution to the exact plugin microservice revision.
7. Server Functions adapt UI intent to automatically loaded `defineActionModel()` methods; they do not replace or duplicate the model layer.
8. Production modules contain protocol and infrastructure behavior only. Domain routing, authorization decisions, and product state belong to composition roots or applications.
9. Optional presentation metadata is immutable build data. The Host derives it from the active deployment and matching artifact manifest; discovery does not carry a second copy and plugins do not control public URLs or visibility. Next.js pages import the lightweight `@hile/rsc/host/plugin-metadata` entry so artifact verification and streaming stay outside their dependency graph.

## Dependency direction

```text
protocol
  ↑        ↑
build   plugin runtime
  ↑        ↑
artifact  transport contracts ← Hile adapter
                ↑
        host runtime + catalogs
                ↑
          Next Flight adapter
                ↕
       client runtime boundary
```

- `protocol` imports no runtime module.
- The package root exports only `protocol`; build, plugin, transport, host, client, artifact, and CLI capabilities use explicit subpaths.
- `plugin` receives an `RscRenderer` and action map; it does not know Hile, WebSocket, HTTP, or Next.
- `transport` defines `RscPluginClient`, `RscPluginLease`, `RscPluginLocator`, and registrar ports. Hile support is one structural adapter.
- `RscHostRuntime` knows only locator and decoder ports. It does not import Next or Hile.
- `host/flight.ts` is the sole Next-private decoder adapter.
- `client` knows logical artifact descriptors, not plugin source paths or host catalog implementation.

## Composition sequence

```text
plugin manifest
  -> RscPluginService(renderer, serverFunctions) + load(models)
  -> attachRscPluginService(registrar, operationMap)
  -> internal transport
  -> catalog-backed RscPluginLocator lease
  -> RscHostRuntime.render()
  -> injected RscFlightDecoder
  -> host Next RSC tree
  -> RemoteClientBoundary
  -> host asset middleware
  -> plugin browser bundle hydration
  -> Host Server Function gateway
  -> internal transport -> exact plugin revision -> model registry
```

Each arrow is an interface boundary. Applications may replace discovery, transport, catalogs, decoder, URL policy, action authorization, and storage independently.

## Lifecycle model

- `install`: verify protocol, exact runtime versions, every declared SHA-256 integrity, regular-file boundaries, and reject undeclared files.
- `activate`: publish a build as the active target for new host requests.
- `upgrade`: mark the previous build `draining`; new leases select the new build while existing leases continue.
- catalog `deactivate`: reject new leases while existing pinned leases finish; plugin-service `deactivate`: abort its in-flight renderer/action work.
- `drain`: wait for all host leases and plugin in-flight work to finish.
- `remove`: delete runtime state only after references reach zero. Immutable browser artifacts may use a longer retention policy selected by the host.

## Fixed ABI versus configurable policy

Fixed ABI:

- protocol version and manifest field meanings;
- bounded plugin presentation metadata and plugin-internal navigation paths;
- exact React/React DOM/RSC runtime identity;
- the logical `RemoteClientBoundary` reference;
- Flight binary semantics and client-reference descriptors.

Configurable policy:

- internal operation names;
- service namespace and discovery mechanism;
- public asset/action/Server Function mount paths;
- deployment selection and retention;
- public navigation URL composition, localization, visibility, and authorization;
- action origin, CSRF, authentication, and authorization;
- error-to-route/status mapping;
- Next decoder implementation for a supported Next version.

Defaults are never hidden ownership. Every default is accepted as an option at the adapter boundary.

## Development lifecycle

Development is an additional composition layer, not a mutable production build:

```text
plugin source change
  -> persistent esbuild contexts rebuild one plugin
  -> successful immutable revision snapshot
  -> plugin microservice atomically activates renderer
  -> plugin updates its Registry announcement under the selected trust policy
  -> Host downloads and verifies the new immutable artifact
  -> Host activates catalog deployment automatically
  -> SSE revision event
  -> browser full-page refresh
```

- Server, browser, and SSR compiler contexts are owned by one `RscDevelopmentCompiler` and disposed explicitly.
- Client graph identity is the canonical boundary path, entry name, and export set. A graph change recreates only browser and SSR contexts.
- Builds are serialized. A failed build, model load, plugin activation, or Host activation does not publish a browser event.
- Model files use an independent atomic registry swap and do not require an RSC asset rebuild.
- Development control state is a local file transport. It does not add another public HTTP endpoint.
- SSE exposes only `pluginId`, `buildId`, and `revision`; filesystem paths and namespaces remain internal.
- Production `buildRscPlugin()` remains a one-shot immutable build and does not import the development coordinator.
- Browser state preservation is intentionally out of scope; activation triggers a full refresh, not React Fast Refresh.
