# Distributed MCP Providers And Gateway

Package: `@hile/mcp`.

`@hile/mcp` turns independently deployed Hile microservices into MCP capability providers and projects them through one public MCP server. It uses the official TypeScript SDK v2 and serves the stable MCP `2026-07-28` protocol over Streamable HTTP, with stdio available for process-local integrations. WebSocket is used only by the internal Hile Micro transport; it is not exposed as an MCP transport.

## Copy-Paste Example

Create one default-exported capability per `mcps/**/*.mcp.ts` file:

```ts
// src/mcps/orders/lookup.mcp.ts
import { defineMcpTool } from '@hile/mcp'
import { z } from 'zod'

export default defineMcpTool(
  {
    name: 'lookup',
    title: 'Look up an order',
    description: 'Returns the current order status.',
    inputSchema: z.object({ id: z.string().min(1) }),
    outputSchema: z.object({ id: z.string(), status: z.string() }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    access: { scopes: ['orders:read'] },
    execution: { timeoutMs: 10_000, retry: 'idempotent-failover' },
  },
  async ({ id }, context) => {
    await context.emit.progress(1, 2, 'Loading order')
    await context.emit.log('info', { event: 'order.lookup', id })
    const order = { id, status: 'ready' }
    return {
      content: [{ type: 'text', text: `${order.id}: ${order.status}` }],
      structuredContent: order,
    }
  },
)
```

Attach the provider only after its `Application` is listening:

```ts
import { createMcpHmacInvocationCredentialCodec } from '@hile/mcp'
import { attachMcpProvider } from '@hile/mcp/micro'

const credentials = createMcpHmacInvocationCredentialCodec({
  secret: process.env.ORDERS_MCP_KEY!,
})

const attachment = await attachMcpProvider(
  application,
  {
    id: 'orders',
    displayName: 'Orders',
    directory: new URL('../mcps', import.meta.url),
  },
  {
    invocationSecurity: { mode: 'credential', credentials },
  },
)

shutdown(() => attachment.close())
```

The loader accepts `*.mcp.ts`, `*.mcp.js`, `*.mcp.tsx`, `*.mcp.jsx`, and `*.mcp.mjs`. Every matched file must default-export one value created by `defineMcpTool`, `defineMcpResource`, or `defineMcpPrompt`. A load or registration failure rolls back the whole provider batch.

For a programmatic provider, compose already-defined capabilities with `defineMcpProvider()` and pass the immutable result directly to `attachMcpProvider()`:

```ts
import { defineMcpProvider } from '@hile/mcp'

const provider = defineMcpProvider({
  id: 'orders',
  displayName: 'Orders',
  tools: { lookup },
  resources: { help, detail },
  prompts: { summarize },
})

const attachment = await attachMcpProvider(application, provider, {
  invocationSecurity: { mode: 'credential', credentials },
})
```

Record keys must equal the capability's local `name`. A tool, resource, or prompt cannot be placed in the wrong record.

## More Examples

Public entry points:

| Import | Responsibility |
|---|---|
| `@hile/mcp` | Definitions, public types, errors, and invocation credential codecs |
| `@hile/mcp/micro` | Provider attachment and Registry-backed provider source |
| `@hile/mcp/gateway` | Unified catalog, naming, visibility, instance selection, and inspection |
| `@hile/mcp/http` | Streamable HTTP middleware for an existing Hile HTTP server |
| `@hile/mcp/stdio` | Process-local stdio serving |
| `@hile/mcp/testing` | In-memory provider source for gateway and adapter tests |

Static resource:

```ts
// src/mcps/orders/help.mcp.ts
import { defineMcpResource } from '@hile/mcp'

export default defineMcpResource(
  {
    kind: 'static',
    name: 'help',
    uri: 'hile://orders/help',
    mimeType: 'text/markdown',
  },
  async (uri) => ({
    contents: [{ uri: uri.toString(), mimeType: 'text/markdown', text: '# Orders\nUse `orders.lookup`.' }],
  }),
)
```

RFC 6570 resource template:

```ts
// src/mcps/orders/detail.mcp.ts
import { defineMcpResource } from '@hile/mcp'

export default defineMcpResource(
  {
    kind: 'template',
    name: 'detail',
    uriTemplate: 'hile://orders/{id}',
    mimeType: 'application/json',
    icons: [{ src: 'https://example.com/orders.svg', mimeType: 'image/svg+xml' }],
    cacheHint: { ttlMs: 30_000, cacheScope: 'private' },
    completions: {
      id: async (value) => searchOrderIds(value),
    },
    access: { scopes: ['orders:read'] },
  },
  async ({ id }) => ({
    contents: [{
      uri: `hile://orders/${encodeURIComponent(String(id))}`,
      mimeType: 'application/json',
      text: JSON.stringify({ id, status: 'ready' }),
    }],
  }),
)
```

Prompt:

```ts
// src/mcps/orders/summarize.mcp.ts
import { defineMcpPrompt } from '@hile/mcp'
import { z } from 'zod'

export default defineMcpPrompt(
  {
    name: 'summarize',
    description: 'Build an order-summary prompt.',
    argsSchema: z.object({ id: z.string().min(1), language: z.string().optional() }),
    completions: {
      language: async (value) => ['en', 'zh-CN'].filter(item => item.startsWith(value)),
    },
    access: { scopes: ['orders:read'] },
  },
  async ({ id }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Summarize order ${id}.` },
    }],
  }),
)
```

`completions` is supported only for declared prompt arguments and RFC 6570 template variables. The gateway routes completion requests to the selected provider instance; static resources do not have completion arguments.

After mutable resource data changes, publish the official resource-updated notification through the attachment. Template variables are expanded with the SDK's RFC 6570 implementation:

```ts
await attachment.notifyResourceUpdated('help')
await attachment.notifyResourceUpdated('detail', { id: order.id })
```

The provider uses one shared update publication per Micro `Application`. The source validates provider ID, instance ID, fingerprint, and URI before the gateway notifies subscribed MCP clients. Sessionful stdio connections keep a per-connection resource subscription set; the Streamable HTTP adapter publishes through the official endpoint notifier and subscription event bus. Stateless HTTP requests do not retain subscriptions across requests.

Unified gateway and Streamable HTTP adapter:

```ts
import {
  createMcpHmacInvocationCredentialCodec,
  createMcpInvocationCredentialKeyring,
} from '@hile/mcp'
import { createMcpGateway } from '@hile/mcp/gateway'
import { createMcpHttpEndpoint } from '@hile/mcp/http'
import { createHileMcpProviderSource } from '@hile/mcp/micro'

const source = createHileMcpProviderSource(application, {
  pollIntervalMs: 2_000,
  onError: (error) => logger.error(error),
})

const gateway = await createMcpGateway({
  source,
  info: { name: 'company-mcp', version: '1.0.0' },
  cacheHints: {
    'tools/list': { ttlMs: 30_000, cacheScope: 'public' },
    'resources/read': { ttlMs: 5_000, cacheScope: 'private' },
  },
  startup: 'require-provider',
  invocationSecurity: {
    mode: 'credential',
    credentials: createMcpInvocationCredentialKeyring({
      orders: createMcpHmacInvocationCredentialCodec({
        secret: process.env.ORDERS_MCP_KEY!,
      }),
    }),
  },
  onError: (error) => logger.error(error),
})

const endpoint = createMcpHttpEndpoint(gateway, {
  path: '/mcp',
  security: {
    allowedHostnames: ['mcp.example.com'],
    allowedOriginHostnames: ['app.example.com'],
    authentication: {
      mode: 'required',
      authenticate: (request) => authenticateMcpRequest(request),
    },
  },
  legacy: 'reject',
})

http.use(endpoint.middleware)
shutdown(async () => {
  await endpoint.close()
  await gateway.close()
})
```

For an OAuth 2.0 protected resource, use the SDK-backed OAuth mode. It validates Bearer tokens and serves the RFC 9728 and RFC 8414 discovery documents on the same existing HTTP server:

```ts
const endpoint = createMcpHttpEndpoint(gateway, {
  path: '/mcp',
  security: {
    allowedHostnames: ['mcp.example.com'],
    allowedOriginHostnames: ['app.example.com'],
    authentication: {
      mode: 'oauth',
      verifier: accessTokenVerifier,
      requiredScopes: ['mcp:read'],
      metadata: {
        resourceServerUrl: new URL('https://mcp.example.com/mcp'),
        oauthMetadata: authorizationServerMetadata,
      },
    },
  },
  legacy: 'reject',
})
```

`@hile/mcp` acts only as the OAuth Resource Server. Token issuance, client registration, consent, and authorization-server persistence remain owned by your identity platform.

Process-local stdio adapter:

```ts
import { serveMcpStdio } from '@hile/mcp/stdio'

const handle = serveMcpStdio(gateway, {
  authInfo: {
    token: 'process-owned',
    clientId: 'local-agent',
    scopes: ['orders:read'],
  },
  onError: (error) => logger.error(error),
})

shutdown(async () => {
  await handle.close()
  await gateway.close()
})
```

Use `gateway.inspect()` for health endpoints and diagnostics. It returns each provider's `ready` or `conflict` state, instance count, fingerprints, conflict reasons, and the currently exposed public names.

## Use When

- Different microservices own different MCP tools, resources, and prompts.
- One MCP endpoint must expose a unified, dynamically discovered catalog.
- Providers need independent deployments, replicas, scopes, and failure isolation.
- Existing exact-peer `Application.streamPeer()` semantics such as cancellation and backpressure must carry MCP execution frames.
- Remote clients use Streamable HTTP or a local MCP host launches a stdio process.

## Do Not Use When

- One process owns a small static MCP server and does not need Hile discovery or distributed routing.
- Work must survive process crashes or be retried later; use a durable queue rather than an MCP invocation stream.
- The Micro network is untrusted and no gateway-to-provider credential verifier is configured.
- A resource should be renamed by the gateway. Resource URIs are provider-owned identities and are never rewritten.

## Install

```bash
pnpm add @hile/mcp @hile/micro zod
```

Node.js `20.12.0` or newer is required. `@hile/mcp` uses the official `@modelcontextprotocol/server` and `@modelcontextprotocol/node` v2 packages internally; applications do not need to register protocol handlers by hand.

## Imports

```ts
import {
  defineMcpPrompt,
  defineMcpProvider,
  defineMcpResource,
  defineMcpTool,
  createMcpHmacInvocationCredentialCodec,
  createMcpInvocationCredentialKeyring,
} from '@hile/mcp'
import { attachMcpProvider, createHileMcpProviderSource } from '@hile/mcp/micro'
import { createMcpGateway } from '@hile/mcp/gateway'
import { createMcpHttpEndpoint } from '@hile/mcp/http'
import { serveMcpStdio } from '@hile/mcp/stdio'
import { InMemoryMcpProviderSource } from '@hile/mcp/testing'
```

## Public API Reference

### Definitions and handler context

| API | Required configuration | Optional configuration | Result |
|---|---|---|---|
| `defineMcpTool(config, handler)` | `name`, Standard Schema `inputSchema` | `title`, `description`, `icons`, `_meta`, `outputSchema`, official tool `annotations`, `access`, `execution` | Immutable `McpToolDefinition` |
| `defineMcpResource(config, handler)` | `kind`, `name`, and either absolute `uri` or RFC 6570 `uriTemplate` | `mimeType`, `icons`, `_meta`, `size`, resource `annotations`, `cacheHint`, template `completions`, `access` | Immutable `McpResourceDefinition` |
| `defineMcpPrompt(config, handler)` | `name`, Standard Schema `argsSchema` | `title`, `description`, `icons`, `_meta`, argument `completions`, `access` | Immutable `McpPromptDefinition` |
| `defineMcpProvider(config)` | `id` | `displayName`, named `tools`, `resources`, `prompts` records | Immutable `McpProviderDefinition` for programmatic attachment |

Names must match `[A-Za-z0-9._-]{1,128}`. Metadata is cloned and frozen when the definition is created. Invalid schemas, annotations, cache hints, completion keys, access policies, timer values, URIs, or retry combinations fail before publication.

Every handler receives `McpInvocationContext`: an abort `signal`, a verified or explicitly trusted `principal`, optional `inputResponses`, `requestState`, and awaited `emit.progress()` / `emit.log()` methods. Treat `requestState` as untrusted unless the gateway configures the official SDK verifier. Template resource variables use the SDK `Variables` shape, so a variable may be a string or string array.

### Provider and discovery APIs

| API | Configuration | Lifecycle and result |
|---|---|---|
| `attachMcpProvider(application, input, options)` | `input` is a `McpProviderDefinition` or `{ id, displayName?, directory }`; `invocationSecurity` must be explicit | Requires a listening Micro Application. Returns `{ provider, manifest, notifyResourceUpdated(), close() }` |
| `createHileMcpProviderSource(application, options?)` | `pollIntervalMs` defaults to `2000` and must be between `100` and `2147483647`; `onError` receives background failures | Returns a source with `start()`, `refresh()`, `snapshot()`, catalog/resource subscriptions, exact-peer `stream()`, and `close()` |
| `HileMcpProviderSource` | Class form of the factory result | Useful when the concrete source type is needed; prefer the factory for normal construction |

One Application may attach multiple providers. The provider host shares one dispatcher and resource-update publication per Application, while manifests and attachment cleanup remain instance-scoped.

### Gateway API

`createMcpGateway(options)` starts the source, builds the initial catalog, and returns `McpGateway` with `inspect()` and `close()`.

| Option | Meaning |
|---|---|
| `source` | Required `McpProviderSource`; production normally uses `createHileMcpProviderSource()` |
| `info` | Required official MCP server implementation name and version |
| `instructions` | Optional server instructions returned to clients |
| `cacheHints` | Optional official SDK cache hints for list/read responses |
| `naming` | Optional provider aliases and `.`, `-`, or `_` public-name separator |
| `startup` | `allow-empty` by default; `require-provider` rejects an empty initial catalog |
| `requestState` | Optional official SDK verifier; without it, client-echoed state remains `unknown` |
| `invocationSecurity` | Required `credential` creator or explicit `trusted-internal` mode |
| `isCapabilityExposed` | Optional principal-aware catalog visibility predicate |
| `onError` | Optional diagnostic callback for isolated projection and background failures |

`inspect()` is read-only operational state. It reports provider readiness, instance counts, fingerprints, conflicts, and currently exposed names; it does not invoke discovery or providers.

### HTTP and stdio adapters

| API or option | Behavior |
|---|---|
| `createMcpHttpEndpoint(gateway, options)` | Returns `{ middleware, close }` and never opens a port |
| `path` | Required absolute endpoint path without query, fragment, or empty segments |
| `security.allowedHostnames` | Required non-empty Host allowlist |
| `security.allowedOriginHostnames` | Required non-empty Origin-host allowlist |
| `security.authentication` | Required explicit `public`, custom `required`, or SDK-backed `oauth` policy |
| `legacy` | Optional `stateless` compatibility or `reject` policy for legacy protocol clients |
| `responseMode` | Optional official SDK per-request response mode: `auto`, `sse`, or `json`; use `sse` when mid-call notifications must be preserved |
| `keepAliveMs` | Optional positive keepalive interval within Node's safe timer range |
| `maxSubscriptions` | Optional positive cap for HTTP subscription listeners |
| `onError` | Optional adapter/transport error callback |
| `serveMcpStdio(gateway, options?)` | Returns the official `StdioServerHandle`; accepts official stdio options plus `authInfo` and `onError` |

Close the HTTP endpoint or stdio handle before closing the shared gateway. `authInfo` is process-level stdio identity; without it, scoped capabilities remain hidden.

### Invocation credentials, testing, and errors

| API | Purpose |
|---|---|
| `createMcpHmacInvocationCredentialCodec(options)` | Creates a replay-protected symmetric codec. `secret` must contain at least 32 bytes; `issuer` defaults to `@hile/mcp`; `ttlMs` defaults to `30000` |
| `createMcpInvocationCredentialKeyring(codecs)` | Selects an isolated credential codec by `providerId`; use different keys for unrelated trust domains |
| `McpInvocationCredentialCodec` | Interface for a custom gateway `create()` / provider `verify()` credential mechanism |
| `InMemoryMcpProviderSource` | Deterministic testing source with `setInstances()`, `emitResourceUpdated()`, recorded `invocations`, and injectable invocation handler |
| `HileMcpError` | Package error carrying a stable `code` |

`HileMcpErrorCode` values are `INVALID_DEFINITION`, `DUPLICATE_CAPABILITY`, `PROVIDER_ATTACH_FAILED`, `PROVIDER_UNAVAILABLE`, `CATALOG_CONFLICT`, and `GATEWAY_CLOSED`. Transport-level MCP failures are still returned according to the official SDK behavior; callers should not assume every tool error rejects the client promise.

## Compose With

- `@hile/micro` supplies Registry snapshots, retained provider manifests, exact-peer routing, cancellation, and streaming.
- `@hile/http` mounts the Streamable HTTP middleware without creating a second public listener.
- `@hile/core` owns startup and reverse-order cleanup.
- Standard Schema implementations such as Zod provide tool and prompt schemas.
- `@hile/redis-idempotency` can protect side effects inside tools; MCP retry annotations are not a business idempotency guarantee.

## Official Capability Coverage

| MCP surface | `@hile/mcp` support |
|---|---|
| Tools | Discovery, schemas, annotations, structured results, progress, input-required round trips, cancellation, timeout, and guarded idempotent failover |
| Resources | Static URIs, RFC 6570 templates, metadata, cache hints, template completion, subscriptions, and updated notifications |
| Prompts | Argument schemas, metadata, completion, and prompt results |
| Dynamic catalogs | Tool, resource, and prompt list-change notifications for connected clients |
| Transports | Official Streamable HTTP and stdio only |
| HTTP authorization | Explicit public/custom authentication or official SDK OAuth Resource Server helpers |

Client-owned roots and server-to-client sampling are not provider definitions in this package. Durable MCP Tasks are also not projected; use a durable application job system when work must survive process failure. The package does not add WebSocket, custom pagination, or another protocol extension that the selected official server SDK does not expose through these surfaces.

## Runtime And Lifecycle Notes

- Provider files are immutable definitions. Runtime instance IDs, fingerprints, Registry topics, and message routes are owned by the attachment.
- One `Application` may attach multiple providers. A shared application-scoped dispatcher routes by provider instance and remains registered until the last attachment closes.
- Every provider instance publishes a retained manifest. Discovery retrieves all matching manifests and their Registry-observed publisher addresses in one batched snapshot.
- A provider is exposed only when every live instance for its provider ID has the same fingerprint. Mixed rolling deployments are reported as conflicts and fail closed.
- Public tool and prompt names default to `providerId.localName`. Configure `naming.aliases` and the `.`, `-`, or `_` separator when required. Resource URIs remain unchanged.
- Compatible instances are selected round-robin. Invocation is bound to the selected instance ID, fingerprint, and publisher address so a stale catalog cannot execute a replacement implementation.
- `idempotent-failover` performs at most one alternate-instance retry and is legal only for tools annotated both read-only and idempotent. A completed result, client cancellation, or downstream notification failure is never retried.
- Provider execution emits progress, log, and one terminal-result frame through a bounded internal channel. Producer emits await capacity, and request cancellation reaches validation, authorization, handlers, connection establishment, and streaming.
- Concurrent cold calls to one provider address share connection establishment. Registry discovery is polled into a cached catalog instead of queried per MCP request.
- Long-lived stdio and subscription-capable servers receive catalog diffs and `list_changed` notifications. Stateless HTTP requests use the cached current projection.
- Prompt and resource-template completion uses the official SDK completion API and executes on the owning provider. Resource updates use official subscription notifications, are delivered only to matching subscriptions, and are accepted from every currently discovered compatible instance fingerprint.
- Capability metadata supports official titles, descriptions, icons, annotations, `_meta`, resource size, and cache hints. Gateway-level list/read cache hints are configured with `cacheHints`.
- OAuth mode delegates Bearer verification, challenges, and metadata documents to official SDK helpers; the package does not implement an authorization server.
- HTTP authentication determines the external principal and scopes. Capability `access.scopes`, `access.authorize`, and gateway `isCapabilityExposed` are separate defense layers.
- Credential mode signs a short-lived, replay-protected envelope bound to the provider, instance, fingerprint, capability, input, and principal. Use a different HMAC key for each provider or trust domain and a gateway keyring. A symmetric key holder can mint credentials for its own trust domain.
- `trusted-internal` is explicit, propagates an unsigned principal, and is appropriate only when every peer able to reach the Micro operation is trusted.
- Client-echoed `requestState` stays `unknown` unless `requestState.verify` is configured on the gateway.
- Close the external transport first, then the gateway, then provider attachments, and finally the underlying Micro applications. Close operations are serialized; provider teardown withdraws discovery before removing handlers.

## Anti-Patterns

- Writing MCP capabilities in arbitrary boot files instead of default-exported `mcps/**/*.mcp.*` files.
- Omitting explicit HTTP authentication mode or gateway-to-provider invocation security.
- Reusing one HMAC secret across unrelated providers or security domains.
- Setting `idempotent-failover` on a write tool or treating a retry annotation as exactly-once execution.
- Querying the Registry for every tool call instead of using `createHileMcpProviderSource()`.
- Routing by namespace after selecting an instance; use the built-in exact-peer source.
- Trusting `requestState`, client claims, resource variables, or handler input before validation.
- Creating a second HTTP listener only for MCP when an existing Hile HTTP server can mount the middleware.

## Verification Checklist

- Every `*.mcp.*` file has one default export created by the matching `defineMcp*` function.
- Tool `inputSchema`, optional `outputSchema`, prompt `argsSchema`, and resource URIs/templates compile successfully.
- The provider application is listening before `attachMcpProvider()` runs.
- Provider and gateway use matching credential configuration, with distinct secrets per provider.
- Host, Origin, and authentication policies are explicit on the HTTP adapter.
- OAuth deployments return protected-resource metadata and a Bearer challenge that points to it.
- `gateway.inspect()` reports `ready` and the expected tool, resource, and prompt names.
- Two compatible replicas appear under one provider ID and receive calls; a mixed-fingerprint rollout produces a conflict instead of routing.
- Progress/log delivery, client cancellation, timeout, and bounded backpressure are exercised.
- Scoped capabilities are hidden without the scope and callable with it over both HTTP and configured stdio.
- Adding or removing a provider updates a long-lived client's catalog notification.
- Prompt and resource-template completion returns provider-owned suggestions, and a subscribed resource receives `notifications/resources/updated` after `notifyResourceUpdated()`.
- Transport, gateway, attachments, and applications close without retained manifests, live handlers, sockets, or timers.
