# @hile/rsc-next

The optional Next.js-specific adapter for decoding internal plugin Flight streams inside a Next request context. Core `@hile/rsc` contains no Next.js private-module imports.

Use `decodePluginFlight()` only inside the Host request and wrap the result with `RscNextClientRuntime` plus `RscClientRuntimeProvider`. `RscNextClientRuntime` installs both the Server Reference implementation and the public Next Router adapter used by remote `RscLink` components. Plugin packages import only `@hile/rsc/client/navigation`; they must not depend on this adapter or Next, and they never construct `_rsc` requests. The supported Next/React tuple and a dynamic catch-all route are in the [end-to-end guide](../../docs/ai/recipes/rsc-plugin-host.md#7-render-through-a-dynamic-next-route).
