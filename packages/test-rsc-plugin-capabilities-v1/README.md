# test-rsc-plugin-capabilities-v1

Private, non-publishable immutable build `demo.rsc.capabilities@v1`.

It demonstrates async Server Components, route/search inputs, a full `'use client'` graph, SSR/hydration, hooks, context, CSS, lazy chunks, internal actions, cancellation, and a plugin process with no HTTP server.

Its signed discovery announcement starts at generation 1; successful immutable development updates increment that generation automatically.

Use v1 to inspect the lower-level direct RSC Action Gateway compatibility path. For new React UI behavior, prefer the v2 module-level `'use server'` Server Function path. Both ultimately execute automatically scanned `defineActionModel()` models; they are intentionally separate browser protocols.

```bash
pnpm build
pnpm verify
pnpm dev
```

Normally start the full topology with `pnpm --filter test-rsc-demo-suite dev` and open `http://127.0.0.1:3200/plugins/demo.rsc.capabilities`.
