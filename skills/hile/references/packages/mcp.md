# Distributed MCP Providers And Gateway

Package: `@hile/mcp`.

`@hile/mcp` turns independently deployed Hile microservices into MCP capability providers and projects them through one public MCP server. It uses the official TypeScript SDK v2 and serves the stable MCP `2026-07-28` protocol over Streamable HTTP, with stdio available for process-local integrations.

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
    argsSchema: z.object({ id: z.string().min(1) }),
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
- Existing `Application.stream()` semantics such as cancellation and backpressure must carry MCP execution frames.
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

## Compose With

- `@hile/micro` supplies Registry snapshots, retained provider manifests, exact-peer routing, cancellation, and streaming.
- `@hile/http` mounts the Streamable HTTP middleware without creating a second public listener.
- `@hile/core` owns startup and reverse-order cleanup.
- Standard Schema implementations such as Zod provide tool and prompt schemas.
- `@hile/redis-idempotency` can protect side effects inside tools; MCP retry annotations are not a business idempotency guarantee.

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
- `gateway.inspect()` reports `ready` and the expected tool, resource, and prompt names.
- Two compatible replicas appear under one provider ID and receive calls; a mixed-fingerprint rollout produces a conflict instead of routing.
- Progress/log delivery, client cancellation, timeout, and bounded backpressure are exercised.
- Scoped capabilities are hidden without the scope and callable with it over both HTTP and configured stdio.
- Adding or removing a provider updates a long-lived client's catalog notification.
- Transport, gateway, attachments, and applications close without retained manifests, live handlers, sockets, or timers.
