# test-rsc-plugin-capabilities-v2

Private immutable replacement build `demo.rsc.capabilities@v2`. It deliberately shares the v1 plugin id while changing build id, namespace, styles, client code, and action behavior so runtime activation is visible without rebuilding the host.

It publishes signed generation 2, so the demo covers generation-aware replacement in addition to immutable build identity.

This is the primary executable reference for the recommended chain:

```text
'use client' + useActionState
  -> module-level 'use server'
  -> same-origin Host authorization
  -> exact-build internal micro request
  -> api.invokeModel('increment', input)
  -> scanned defineActionModel()
```

It also demonstrates Server Components, Ant Design inside the remote client boundary, imported plugin CSS, SSR/hydration, modal/local state, tables, and Host-owned outer layout composition.

```bash
pnpm build
pnpm verify
pnpm dev
```

Normally run `pnpm --filter test-rsc-demo-suite dev`, then select v2 from the Host page and submit the Server Function form. Read [`src/plugin/actions.ts`](src/plugin/actions.ts), [`src/plugin/update-panel.tsx`](src/plugin/update-panel.tsx), [`src/models/increment.model.ts`](src/models/increment.model.ts), and [`src/services/plugin.boot.ts`](src/services/plugin.boot.ts) in that order.
