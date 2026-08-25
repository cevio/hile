# RSC plugin service

This project is an independently built RSC plugin runtime. It creates no HTTP server.

1. Start a Hile registry at the configured `REGISTRY_HOST:REGISTRY_PORT`.
2. Run `pnpm build` to create and verify the immutable production RSC artifact.
3. Run `pnpm dev`: the persistent compiler and service stay alive together; source edits create immutable incremental revisions, while model edits reload only action models.
4. Create and start a separate project from the `rsc-host` template. This service publishes an instance-scoped Registry announcement, so no artifact path, namespace list, install call, or activation call is configured in the Host.

The default `hile-rsc.json` intentionally omits `buildId`, `outdir`, and `runtime`. Each production build receives an immutable ID automatically, is written below `.hile-rsc`, and uses the runtime tuple supported by the installed RSC packages; set `RSC_BUILD_ID` only when a deployment system needs to supply that identity.

Development keeps stable `MICRO_NAMESPACE` and `RSC_INSTANCE_ID` values so one publisher can update incremental revisions. Production omits both by default, deriving a unique routable namespace and publisher identity from the immutable manifest plugin/build IDs; set either variable only when the deployment platform supplies values unique to every concurrently running immutable build.

Keep product routes, permissions, and domain logic outside the runtime composition code. Define browser-callable behavior with `defineActionModel()` under the domain-oriented `src/models` tree; the runtime scans models and mounts only explicitly marked action models.

The optional `metadata` block in `hile-rsc.json` is immutable presentation data for Host-owned shells. Navigation paths are plugin-internal declared routes; the Host decides public URLs, authorization, visibility, and the final component library.

`RSC_DISCOVERY_GENERATION` starts the monotonic generation for this instance. HMAC mode signs it. Use a higher value for a newer immutable deployment at equal priority; successful runtime artifact updates increment it automatically.

The generated files select HMAC discovery by default. A deployment where every peer able to reach the internal Hile Micro mesh is trusted may instead use `authentication: { mode: 'trusted-internal' }`, pair it with `createTrustedInternalRscDiscoveryAuthorizer()` in the Host, document that trust boundary next to both calls, and remove the unused discovery key configuration.

## Add interactive server behavior

1. Put a default-exported `defineActionModel()` in `src/models/<domain>/<name>.model.ts`.
2. Put module-level `'use server'` in a plugin-owned actions file and export `defineRscServerFunction(async (api, ...args) => ...)` definitions.
3. Call the path-derived model ID with `api.invokeModel()`; for example `example/increment.model.ts` is `example/increment`.
4. Import that Server Function from a `'use client'` component and call it, pass it to a form, or use `useActionState`.

Do not add an action map, public HTTP endpoint, or Next dependency. For a complete example including Host authorization and development, read `docs/ai/recipes/rsc-plugin-host.md` in the Hile repository.
