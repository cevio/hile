# test-rsc-plugin-isolation

Private plugin `demo.rsc.isolation@isolation-v1`. It proves a second plugin can own a separate server module, client graph, CSS, routes, namespace, internal port, and state while sharing only the host's React runtime and public origin.

Use this package to verify that discovery and loading are keyed by immutable `{ pluginId, buildId, namespace }`, not a hardcoded inventory or filesystem import. Its UI is still placed inside the Host-owned layout and reaches the browser through the same public endpoint.

```bash
pnpm build
pnpm verify
pnpm dev
```

Normally start it with the full `pnpm --filter test-rsc-demo-suite dev` topology.
