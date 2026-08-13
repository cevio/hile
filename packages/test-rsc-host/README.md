# test-rsc-host

Private, non-publishable composition root for the RSC Demo. It is the only package that depends on Next or starts a public HTTP listener.

It demonstrates:

- one `HttpNext` endpoint on `http://127.0.0.1:3200`;
- internal Hile discovery through the registry on `127.0.0.1:9876`;
- immutable artifact registration and sanitized same-origin assets;
- Flight streaming and decoding with request cancellation;
- SSR and browser resolution of remote `'use client'` graphs;
- authorized remote actions;
- multiple plugins and runtime install/activate/deactivate/remove operations.

```bash
pnpm build
pnpm dev
```
