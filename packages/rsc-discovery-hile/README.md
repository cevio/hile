# @hile/rsc-discovery-hile

Hile-specific adapters for signed Registry discovery, bounded message-stream artifact transfer, automatic Host deployment, and plugin process composition. Both `plugin.json` and every declared artifact are streamed directly to isolated temporary files with backpressure and limits; artifact bodies are never assembled in memory.

`HileRscPluginRuntime` composes one plugin microservice lifecycle: attach RSC transport operations, start the internal listener, publish the signed artifact, bind optional development activation, and close every phase in retryable order. Plugin packages only provide configuration and optional adapters; no public HTTP listener is created.

The package implementation is separated by responsibility: `authentication` owns trust verification, `publisher` owns signed Registry publication and artifact serving, `reader` owns Registry snapshots, `downloader` owns bounded stream-to-disk transfer, `host` owns automatic deployment, and `plugin-runtime` owns process composition. The root module is only the public export surface.

## Recommended entry points

- Plugin: construct `HileRscPluginRuntime`, call `start()`, and register `close()` with Hile shutdown.
- Host: construct `HileRscDiscoveryHost` with `createHmacRscDiscoveryAuthorizer()`, call `start()`, and close it before the Host Micro application.
- Trust: bind every `keyId` to a non-empty explicit `pluginIds` allowlist. Registry presence is discovery, not authorization.
- Transfer: use the built-in downloader; it streams manifests and artifacts to isolated files with backpressure and limits instead of accumulating bodies in memory.

See the [complete plugin and Host composition](../../docs/ai/recipes/rsc-plugin-host.md).
