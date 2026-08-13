# test-rsc-plugin-isolation

Private plugin `demo.rsc.isolation@isolation-v1`. It proves a second plugin can own a separate server module, client graph, CSS, routes, namespace, internal port, and state while sharing only the host's React runtime and public origin.

```bash
pnpm build
pnpm verify
pnpm dev
```
