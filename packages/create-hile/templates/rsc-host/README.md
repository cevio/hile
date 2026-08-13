# Single-endpoint RSC host

This project owns the only public `HttpNext` listener. Plugin Flight generation remains in internal Hile services created from the `rsc-plugin` template.

1. Start the Hile registry.
2. Build and start the plugin project.
3. Set `RSC_ARTIFACT_ROOT`, `RSC_PLUGIN_NAMESPACE`, and the registry address.
4. For development, set `RSC_DEVELOPMENT_STATE` to the plugin project's state file and run `pnpm dev` in both projects. The Host activates verified revisions and the browser reload client listens on the same public endpoint.

The composition root verifies immutable artifacts, mounts browser assets, connects the internal micro transport, holds exact build leases, forwards disconnect cancellation, and decodes Flight inside the Next request context. Add authentication and CSRF policy by composing `RscActionGateway` and `createRscActionMiddleware`; do not put permission decisions in `@hile/rsc`.

The catch-all route `/plugins/[pluginId]/[[...path]]` resolves the active build from the deployment catalog and forwards the remaining URL path to the plugin manifest. Add or replace host routes as composition policy; the runtime does not hardcode product routes.
