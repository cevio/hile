# test-rsc-plugin-capabilities-v2

Private immutable replacement build `demo.rsc.capabilities@v2`. It deliberately shares the v1 plugin id while changing build id, namespace, styles, client code, and action behavior so runtime activation is visible without rebuilding the host.

```bash
pnpm build
pnpm verify
pnpm dev
```
