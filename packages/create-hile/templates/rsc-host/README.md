# Single-endpoint RSC host

This project owns the only public `HttpNext` listener. Plugin Flight generation remains in internal Hile services created from the `rsc-plugin` template.

1. Start the Hile registry.
2. Build and start the plugin project.
3. Set the registry address and run the Host. Every compatible RSC microservice registered in Registry is discovered, downloaded through message streaming, verified, and activated automatically.
4. For development, run `pnpm dev` in both projects. Plugin revisions update their Registry announcement and the browser reload client listens on the same public endpoint; the Host never reads another service's local files.

The composition root verifies immutable artifacts, mounts browser assets, connects the internal micro transport, holds exact build leases, forwards disconnect cancellation, and decodes Flight inside the Next request context. Add authentication and CSRF policy by composing `RscActionGateway` and `createRscActionMiddleware`; do not put permission decisions in `@hile/rsc`.

The generated route also configures total/idle Flight timeouts, a bounded stream window, shared immutable-manifest verification, and render observation. `src/app/rsc-client-runtime.tsx` owns loading/error/retry UI inside a Client Component, while Registry snapshot concurrency is bounded in the Host service.

The catch-all route `/plugins/[pluginId]/[[...path]]` resolves the active build from the deployment catalog and forwards the remaining URL path to the plugin manifest. Add or replace host routes as composition policy; the runtime does not hardcode product routes.

## Required trust and UI composition

- The generated files select HMAC discovery by default. `RSC_DISCOVERY_PLUGIN_IDS` must explicitly list the plugin IDs owned by the configured discovery key.
- A deployment where every peer able to reach the internal Hile Micro mesh is trusted may instead pair plugin `authentication: { mode: 'trusted-internal' }` with Host `createTrustedInternalRscDiscoveryAuthorizer()`. Document that deployment trust boundary next to both calls and remove the unused discovery key configuration.
- The same `RSC_ASSET_MOUNT` must configure the asset middleware and `RscClientRuntimeProvider`.
- Keep `<html>`, `<body>`, navigation, authentication shell, global CSS-in-JS collector, and application error boundaries in the Host layout.
- Derive navigation from `listActiveRscPlugins(deployments, artifacts)`. The scaffold reads immutable plugin metadata but keeps public URL composition, filtering, permissions, and final UI in the Host.
- Keep plugin-specific providers, theme, styles, and interactive state inside the plugin boundary.
- Replace the example CSRF token check with the application's authentication, CSRF, and authorization policy before production.
- In HMAC mode, keep `RSC_DISCOVERY_REQUIRE_GENERATION=false` only while legacy publishers are being upgraded; production defaults to `true` so generation fields cannot be stripped to downgrade a signed announcement.
- A caller-owned generation high-water store belongs to one live discovery Host; close the old Host successfully before reusing that store in a replacement.

For the full file-by-file implementation, development flow, checks, and troubleshooting, read `docs/ai/recipes/rsc-plugin-host.md` in the Hile repository.
