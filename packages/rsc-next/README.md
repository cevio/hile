# @hile/rsc-next

The optional Next.js-specific adapter for decoding internal plugin Flight streams inside a Next request context. Core `@hile/rsc` contains no Next.js private-module imports.

Use `decodePluginFlight()` only inside the Host request and wrap the result with `RscNextClientRuntime` plus `RscClientRuntimeProvider`. `RscNextClientRuntime` installs both the Server Reference implementation and the public Next Router adapter used by remote `RscLink` components. Opt-in `prefetch="intent"` and `prefetch="viewport"` calls are fail-closed until the Host supplies `allowRoutePrefetch`; that callback must return `true` only when the destination matches an active manifest route declaring `prefetch: "route"`. Plugin packages import only `@hile/rsc/client/navigation`; they must not depend on this adapter or Next, and they never construct `_rsc` requests. Hosts may combine this policy-gated router prefetch with the exact-build, byte- and file-bounded `preloadRscRouteAssets()` API from `@hile/rsc/client`. The supported Next/React tuple and a dynamic catch-all route are in the [end-to-end guide](../../docs/ai/recipes/rsc-plugin-host.md#7-render-through-a-dynamic-next-route).

For document-heavy public routes, a Host may explicitly register
`createContentFirstRscHtmlMiddleware()` from `@hile/rsc-next/content-first` before
`HttpNext.start()`. It streams ordinary SSR HTML immediately while retaining only
bounded, byte-identical inline `self.__next_f` scripts, then emits those scripts in
their original order immediately before `</body>`. If the configured Flight-byte
bound is exceeded, the transform flushes the retained scripts at that point and
passes all remaining bytes through unchanged. At the first body write, exact
`text/html` responses with identity or gzip encoding are transformed. Gzip
responses are decoded, reordered, and re-encoded as a streaming pipeline; other
content encodings and gzip responses with an already-sent fixed content length
pass through unchanged. Representation validators and digests are removed before
transformation; a response whose validators were already sent passes through
unchanged. Normal Next asset, RSC, and Server Function responses therefore bypass
the transform. This trades later hydration and gzip recompression work for earlier
complete document text; use it only when that product trade-off is intentional.
The byte limit applies to each in-flight HTML response, so size it for expected
concurrency. Host and third-party scripts must not depend on observing Next's
private `self.__next_f` state before the document body completes.
