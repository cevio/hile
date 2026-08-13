# @hile/rsc-next

The optional Next.js-specific adapter for decoding internal plugin Flight streams inside a Next request context. Core `@hile/rsc` contains no Next.js private-module imports.

Use `decodePluginFlight()` only inside the Host request and wrap the result with `RscNextClientRuntime` plus `RscClientRuntimeProvider`. Plugin packages must not depend on this adapter or Next. The supported Next/React tuple and a dynamic catch-all route are in the [end-to-end guide](../../docs/ai/recipes/rsc-plugin-host.md#7-render-through-a-dynamic-next-route).
