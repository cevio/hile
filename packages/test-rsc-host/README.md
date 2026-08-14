# test-rsc-host

Private, non-publishable composition root for the RSC Demo. It is the only package that depends on Next or starts a public HTTP listener.

It demonstrates:

- one `HttpNext` endpoint on `http://127.0.0.1:3200`;
- internal Hile discovery through the registry on `127.0.0.1:9876`;
- immutable artifact registration and sanitized same-origin assets;
- Flight streaming and decoding with request cancellation;
- bounded Flight window/total/idle timeouts, shared manifest verification, and render metrics;
- bounded concurrent discovery snapshots and signed generation-aware upgrades;
- SSR and browser resolution of remote `'use client'` graphs;
- Host-owned loading/error/retry UI defined entirely inside a Client Component;
- an authorized same-origin Server Function gateway that forwards to the exact plugin microservice build;
- multiple plugins with Registry-driven automatic enable, upgrade, failover and removal;
- no static plugin inventory and no manual install/activate endpoint.

```bash
pnpm --filter test-rsc-demo-suite dev
```

Open `http://127.0.0.1:3200/`. Do not start this package alone unless Registry and the three demo plugin services are already running. The suite command owns/reuses Registry, starts every internal service, waits for readiness, and stops only its own processes.

Key files:

- `src/services/runtime.boot.ts`: catalogs, signed discovery, stream-to-disk deployment, asset and Server Function middleware, and the only `HttpNext` listener;
- `src/app/plugins/[pluginId]/[[...path]]/page.tsx`: exact active-build lease, Flight decode, request cancellation, stream controls, and observation;
- `src/app/rsc-client-runtime.tsx`: Host-owned Next/client providers plus loading/error/retry policy;
- `src/app/layout.tsx` and `src/app/host-shell.tsx`: Host-owned outer layout and Ant Design CSS-in-JS registry;
- `src/app/page.tsx`: deployment status only; it is not a static plugin inventory.

The canonical construction guide is [`docs/ai/recipes/rsc-plugin-host.md`](../../docs/ai/recipes/rsc-plugin-host.md).
