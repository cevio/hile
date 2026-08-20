# @hile/rsc-discovery-hile

Hile-specific adapters for explicitly secured Registry discovery, bounded message-stream artifact transfer, automatic Host deployment, and plugin process composition. Both `plugin.json` and every declared artifact are streamed directly to isolated temporary files with backpressure and limits; artifact bodies are never assembled in memory.

`HileRscPluginRuntime` composes one plugin microservice lifecycle: attach RSC transport operations, start the internal listener, publish the artifact with explicit discovery security, bind optional development activation, and close every phase in retryable order. Plugin packages only provide configuration and optional adapters; no public HTTP listener is created.

The package implementation is separated by responsibility: `authentication` owns trust verification, `publisher` owns Registry publication and artifact serving, `reader` owns Registry snapshots, `downloader` owns bounded stream-to-disk transfer, `host` owns automatic deployment, and `plugin-runtime` owns process composition. The root module is only the public export surface.

## Recommended entry points

- Plugin: construct `HileRscPluginRuntime`, call `start()`, and register `close()` with Hile shutdown.
- Identity: use `resolveHileRscPluginIdentity()` to keep development routing stable while deriving build-scoped production namespaces and publisher IDs; explicit deployment-provided values remain supported.
- Host: construct `HileRscDiscoveryHost` with an explicit authorizer, call `start()`, and close it before the Host Micro application.
- Trusted mesh: pair publisher `authentication: { mode: 'trusted-internal' }` with `createTrustedInternalRscDiscoveryAuthorizer()` only when every peer able to reach the internal Hile Micro network is trusted.
- HMAC: pair `{ keyId, secret }` with `createHmacRscDiscoveryAuthorizer()` and bind every `keyId` to a non-empty explicit `pluginIds` allowlist.
- Migration: upgrade Host readers before publishers start emitting `trusted-internal`; new readers accept old signed announcements, but old readers reject the unsigned shape. Misspelled or mixed trusted-mode configuration fails before publication.
- Transfer: use the built-in downloader; it streams manifests and artifacts to isolated files with backpressure and limits instead of accumulating bodies in memory.

See the [complete plugin and Host composition](../../docs/ai/recipes/rsc-plugin-host.md).
