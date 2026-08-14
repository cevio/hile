# RSC plugin service

This project is an independently built RSC plugin runtime. It creates no HTTP server.

1. Start a Hile registry at the configured `REGISTRY_HOST:REGISTRY_PORT`.
2. Run `pnpm build` to create and verify the immutable production RSC artifact.
3. Run `pnpm dev`: the persistent compiler and service stay alive together; source edits create immutable incremental revisions, while model edits reload only action models.
4. Create and start a separate project from the `rsc-host` template. This service publishes an instance-scoped Registry announcement, so no artifact path, namespace list, install call, or activation call is configured in the Host.

Keep product routes, permissions, and domain logic outside the runtime composition code. Define browser-callable behavior with `defineActionModel()` under the domain-oriented `src/models` tree; the runtime scans models and mounts only explicitly marked action models.

`RSC_DISCOVERY_GENERATION` starts the signed monotonic generation for this instance. Use a higher value for a newer immutable deployment at equal priority; successful runtime artifact updates increment it automatically.

## Add interactive server behavior

1. Put a default-exported `defineActionModel()` in `src/models/<domain>/<name>.model.ts`.
2. Put module-level `'use server'` in a plugin-owned actions file and export only async functions.
3. Call the path-derived model ID with `invokeRscModel()`; for example `example/increment.model.ts` is `example/increment`.
4. Import that Server Function from a `'use client'` component and call it, pass it to a form, or use `useActionState`.

Do not add an action map, public HTTP endpoint, or Next dependency. For a complete example including Host authorization and development, read `docs/ai/recipes/rsc-plugin-host.md` in the Hile repository.
