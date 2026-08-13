# Single-endpoint RSC host

This project owns the only public `HttpNext` listener. Plugin Flight generation remains in internal Hile services created from the `rsc-plugin` template.

1. Start the Hile registry.
2. Build and start the plugin project.
3. Set the registry address and run the Host. Every compatible RSC microservice registered in Registry is discovered, downloaded through message streaming, verified, and activated automatically.
4. For development, run `pnpm dev` in both projects. Plugin revisions update their Registry announcement and the browser reload client listens on the same public endpoint; the Host never reads another service's local files.

The composition root verifies immutable artifacts, mounts browser assets, connects the internal micro transport, holds exact build leases, forwards disconnect cancellation, and decodes Flight inside the Next request context. Add authentication and CSRF policy by composing `RscActionGateway` and `createRscActionMiddleware`; do not put permission decisions in `@hile/rsc`.

The catch-all route `/plugins/[pluginId]/[[...path]]` resolves the active build from the deployment catalog and forwards the remaining URL path to the plugin manifest. Add or replace host routes as composition policy; the runtime does not hardcode product routes.

## Required trust and UI composition

- `RSC_DISCOVERY_PLUGIN_IDS` must explicitly list the plugin IDs owned by the configured discovery key. Registry announcements are never trusted by presence alone.
- The same `RSC_ASSET_MOUNT` must configure the asset middleware and `RscClientRuntimeProvider`.
- Keep `<html>`, `<body>`, navigation, authentication shell, global CSS-in-JS collector, and application error boundaries in the Host layout.
- Keep plugin-specific providers, theme, styles, and interactive state inside the plugin boundary.
- Replace the example CSRF token check with the application's authentication, CSRF, and authorization policy before production.

For the full file-by-file implementation, development flow, checks, and troubleshooting, read `docs/ai/recipes/rsc-plugin-host.md` in the Hile repository.
