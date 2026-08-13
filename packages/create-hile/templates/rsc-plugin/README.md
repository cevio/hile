# RSC plugin service

This project is an independently built RSC plugin runtime. It creates no HTTP server.

1. Start a Hile registry at the configured `REGISTRY_HOST:REGISTRY_PORT`.
2. Run `pnpm build` to create and verify the immutable production RSC artifact.
3. Run `pnpm dev`: the persistent compiler and service stay alive together; source edits create immutable incremental revisions, while model edits reload only action models.
4. Create a separate project from the `rsc-host` template and point it at this artifact and namespace.

Keep product routes, permissions, and domain logic outside the runtime composition code. Define browser-callable behavior with `defineActionModel()` under the domain-oriented `src/models` tree; the runtime scans models and mounts only explicitly marked action models.
