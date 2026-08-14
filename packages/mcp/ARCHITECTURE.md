# @hile/mcp Architecture

`@hile/mcp` is a distributed capability layer, not a monolithic MCP service. Each microservice owns and deploys its tools, resources, prompts, schemas, authorization, and handlers. A separate gateway discovers those providers and projects one MCP server to external clients.

The package targets the stable MCP `2026-07-28` protocol through the official TypeScript SDK v2. Streamable HTTP is the remote transport; stdio is the process-local transport.

## Dependency Direction

```text
immutable capability definitions
          ↓
mcps filesystem loader
          ↓
application-scoped provider host
          ↓
instance attachment → retained Registry manifest
          ↓
batched provider source → validated instance snapshot
          ↓
compatible catalog → principal-specific MCP projection
          ↓
official Streamable HTTP / stdio adapters
```

Dependencies point toward definitions and the existing Hile Micro primitives. Definitions never import Registry, HTTP, stdio, connection, or gateway objects.

## Module Responsibilities

| Module | Owns | Does not own |
|---|---|---|
| Root definitions | Immutable schemas, metadata, access policy, handlers, credential codecs | Discovery, routing, transport lifecycle |
| `@hile/mcp/micro` provider | `mcps` loading, shared operation dispatch, manifest publication, provider cleanup | Public names, external auth, client transport |
| `@hile/mcp/micro` source | Batched Registry snapshots, manifest validation, exact publisher address, polling lifecycle | Capability execution policy |
| `@hile/mcp/gateway` | Compatibility catalog, public names, visibility, instance selection, MCP registrations | Public socket ownership, provider business logic |
| `@hile/mcp/http` | Streamable HTTP adaptation, path, Host/Origin checks, external authentication | Port binding, provider credentials |
| `@hile/mcp/stdio` | One process-pinned MCP connection and optional process principal | HTTP or Registry lifecycle |
| `@hile/mcp/testing` | Deterministic in-memory provider snapshots and streams | Production discovery |

## Provider Construction

Capability files live under a provider-owned `mcps` directory and default-export one branded definition:

```text
src/mcps/
  search.mcp.ts       # defineMcpTool
  manual.mcp.ts       # defineMcpResource
  summarize.mcp.ts    # defineMcpPrompt
```

The loader requires a default export, classifies the definition by `kind`, verifies that record names match capability names, and rejects duplicates. Loading is transactional: any import, validation, or registration error unwinds the whole batch.

An attachment is created after the Micro `Application` is listening because its manifest must contain a reachable publisher address. Runtime identity is generated rather than configured:

- provider ID is the stable logical owner;
- instance ID identifies one running attachment;
- fingerprint hashes the canonical public capability manifest;
- Registry topic is scoped by provider ID and instance ID;
- publisher address comes from the listening Application.

One Application may attach multiple providers. They share one application-scoped Micro operation dispatcher. The dispatcher selects by instance ID and then verifies provider ID and fingerprint before a handler can run. Closing one attachment cannot overwrite or unregister another provider's route.

## Discovery Plane

Each instance publishes one retained manifest. A source periodically asks Registry for every matching topic, payload, and publisher in one snapshot operation. It accepts a manifest only when:

- its topic, provider ID, and instance ID agree;
- all names, annotations, schemas, resource URIs, templates, execution settings, and retry invariants are valid;
- exactly one publisher owns the instance topic;
- the manifest address equals the Registry-observed publisher address;
- its fingerprint matches canonical, locale-independent serialization.

The source commits a complete next snapshot atomically. Listener failures are reported but do not prevent other listeners from receiving the committed snapshot. Closing the source aborts an in-flight Registry request and clears polling and subscriptions.

Discovery is not in the invocation hot path. The gateway builds and caches a catalog only when the source snapshot changes.

## Catalog And Naming

The gateway groups instances by provider ID. A group is ready only when every live instance has the same fingerprint. During a mixed rolling deployment, the entire provider is marked `conflict` and omitted until replicas converge. Unrelated providers remain available.

The catalog also fails closed on:

- duplicate public tool, resource, or prompt names;
- duplicate static URI or template identity;
- invalid aliases or generated public names;
- malformed SDK schemas or metadata.

Tool and prompt names default to `providerId.localName`. The separator may be `.`, `-`, or `_`, and provider aliases may replace the prefix. Resource names are projected for MCP registration, but provider-owned resource URIs and templates are never rewritten.

`gateway.inspect()` exposes provider readiness, instance counts, fingerprints, conflict reasons, and the current public capability names for operational health checks.

## Live Projections

Each connected MCP server receives a principal-specific projection of the cached catalog. Required scopes and `isCapabilityExposed` run before a capability is registered.

When discovery changes, the gateway calculates the new projection before mutating live server registrations. It then replaces handles and sends the appropriate tool, resource, or prompt `list_changed` notification. Projection errors are isolated per connection and sent to `onError`; one client policy cannot block catalog updates for another client.

Stateless Streamable HTTP requests project the current cached catalog. Pinned stdio and subscription-capable connections remain synchronized without reconnecting.

## Invocation Plane

```text
MCP request
  → external principal and visible catalog entry
  → compatible instance selection
  → instance-bound credential creation
  → exact publisher connection
  → provider identity and credential verification
  → schema validation
  → scope and authorize checks
  → capability handler
  → progress / log / terminal result frames
  → MCP response
```

Compatible replicas are selected round-robin. The wire envelope contains the expected provider ID, instance ID, fingerprint, capability kind, local name, and input. `streamPeer()` targets the selected publisher address; the provider rejects the request if the process now serving that address does not match the selected identity. This closes the catalog-to-invocation replacement race.

Tools, resources, and prompts use the same internal streaming path. The provider emits zero or more progress/log frames followed by exactly one terminal result. Frames after a result, an unknown frame, or a stream ending without a result are provider failures.

## Streaming And Performance

- Discovery uses one batched Registry snapshot per poll, never one request per provider or invocation.
- The gateway routes from an immutable cached catalog and reparses only changed snapshots.
- Concurrent cold calls to one provider address share one connection attempt.
- Each caller retains its own timeout and cancellation deadline while sharing the handshake.
- Established Micro clients are reused by the existing Application connection pool.
- Provider frame channels have bounded capacity. `emit.progress()` and `emit.log()` await capacity, preserving backpressure instead of growing an unbounded buffer.
- Abort propagates through connection establishment, schema validation boundaries, authorization, handler execution, notifications, and stream consumption.
- Timer values use a shared safe bound to avoid Node timer overflow.

Tool failover is deliberately narrow. `idempotent-failover` is accepted only with both `readOnlyHint: true` and `idempotentHint: true`, and it performs at most one alternate-instance attempt. A client cancellation, delivered terminal result, MCP error result, or downstream notification failure is never retried. Business side effects still require a real idempotency boundary.

## Trust Boundaries

External transport security and internal invocation security are separate.

### External MCP boundary

The HTTP adapter requires explicit non-empty Host and Origin hostname allowlists and an explicit authentication mode. Required authentication produces SDK `AuthInfo`; the gateway converts it to a normalized principal, filters the catalog, and forwards only the normalized identity. Public access must be selected explicitly.

stdio may supply one process-level `authInfo`. Without it, scoped capabilities are not exposed.

### Gateway-to-provider boundary

Credential mode signs a short-lived envelope bound to the exact provider, instance, fingerprint, capability, input, and normalized principal. Providers verify before creating `context.principal`. Nonces are replay-protected.

The built-in HMAC codec is symmetric. Use a different secret per provider or trust domain and select it through the gateway keyring. Any service holding a symmetric key can mint credentials within that key's domain; do not distribute one global secret to unrelated providers.

`trusted-internal` is an explicit alternative for a fully trusted Micro mesh. It propagates an unsigned principal, so any peer that can invoke the internal operation must be trusted not to forge identity.

Capability `access.scopes` is enforced in both catalog visibility and provider authorization. Capability-local `authorize()` runs at the provider after input validation.

Client-echoed `requestState` remains `unknown` unless the gateway is configured with an SDK `requestState.verify` hook. Type parameters alone do not establish trust.

## Lifecycle And Failure Atomicity

Recommended shutdown order:

1. stop accepting external HTTP or stdio work;
2. close the gateway, which rejects new invocations, aborts active streams, waits for them, and closes discovery;
3. close provider attachments, which withdraw discovery before removing handlers and definitions;
4. stop the underlying Micro Applications and Registry-owned connections.

Attachment, source, and gateway close operations serialize concurrent callers. Provider cleanup is phased and retryable. If manifest withdrawal cannot complete while the provider is still reachable, handlers remain registered so Registry cannot advertise a dead operation. Application publication intent is removed even when the Application has already stopped, preventing a later restart from replaying a closed provider.

Startup follows the reverse dependency order and rolls back completed phases if a later phase fails.

## Public API Boundary

The stable entry points are intentionally separated by responsibility:

```ts
import { defineMcpTool } from '@hile/mcp'
import { attachMcpProvider, createHileMcpProviderSource } from '@hile/mcp/micro'
import { createMcpGateway } from '@hile/mcp/gateway'
import { createMcpHttpEndpoint } from '@hile/mcp/http'
import { serveMcpStdio } from '@hile/mcp/stdio'
import { InMemoryMcpProviderSource } from '@hile/mcp/testing'
```

Consumers should not import internal manifest, loader, stream, provider-host, or gateway-projection modules. Those are implementation details that can evolve without widening the public architecture.

## Further Reading

- [Package README](./README.md)
- [MCP `2026-07-28` release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Official TypeScript SDK server guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
