# Single-Host RSC Plugin Recipe

Use this recipe to assemble a domain-free RSC plugin platform. Application routes and authorization decisions remain outside `@hile/rsc`.

## Complete Example

```ts
const service = new RscPluginService({
  manifest,
  renderer: createOfficialRscRenderer(artifactRoot),
})
const detach = attachRscPluginService(service, pluginRegistrar)

const locator = createCatalogRscPluginLocator(deploymentCatalog, async (deployment) =>
  createHileRscPluginClient(hostApplication, deployment.namespace))
const hostRuntime = new RscHostRuntime({ locator, decoder })

const tree = await hostRuntime.render({
  pluginId,
  request: { buildId, path },
  signal: requestSignal,
})
```

The plugin registrar and host application are internal transports. Only the separately composed `HttpNext` host owns public HTTP.

## Plugin build

Create a config with `pluginId`, immutable `buildId`, source root, entry, output directory, route exports, and the exact React/RSC runtime tuple. Run `hile-rsc build`, then `hile-rsc verify` before installation.

The build emits:

- `server-rsc`: Server Component bundle;
- `client-ssr`: host-React-compatible SSR bundles and integrity-declared lazy chunks;
- `client-browser`: host-React-compatible browser bundles and lazy chunks;
- CSS assets and SHA-256 integrity;
- `plugin.json` protocol manifest.

## Internal plugin runtime

```ts
const service = new RscPluginService({
  manifest,
  renderer: createOfficialRscRenderer(artifactRoot),
})
await service.load(fileURLToPath(new URL('../models', import.meta.url)))

const detach = attachRscPluginService(service, microServer, operationMap)
```

`operationMap` is optional and configurable. No plugin code creates HTTP.

## Host composition

1. Verify and register immutable artifacts in an `RscArtifactCatalog`.
2. Install `{ pluginId, buildId, namespace }` in an `RscDeploymentCatalog`.
3. Create a catalog-backed locator whose connector returns an `RscPluginClient`.
4. Create `RscHostRuntime` with that locator and a request-scoped Next decoder.
5. Wrap decoded trees with `RscClientRuntimeProvider` using the same asset mount configured on `createRscAssetMiddleware`.
6. Forward `getHttpNextRequestSignal()` so client disconnect aborts the internal stream.

## Upgrade

1. Verify and install the new immutable build without replacing old files.
2. Activate the new deployment; the previous one becomes `draining`.
3. New page renders acquire the new build.
4. Existing renders retain the old lease until the decoder consumes or closes the Flight stream.
5. After `catalog.drain(oldBuild)` and `service.drain()`, stop the old runtime.
6. Retain old browser assets according to host cache policy before removal.

## Actions

Use `RscActionGateway` with a required application-supplied authorizer. `createSameOriginCsrfAuthorizer` composes origin and token validation, but the application still owns authentication, token issuance, and permission decisions.

Define browser-callable behavior with `defineActionModel()` anywhere in the domain-organized `src/models` tree. `ModelActionRegistry` scans every `*.model.*` file, validates its default export, and mounts only action-marked models. An action id is the relative model path (`account/update.model.ts` becomes `account/update`). Ordinary `defineModel()` exports remain internal.

Action bodies use `{ input: object }`, matching the model input contract. Never accept a namespace, internal message URL, metadata, retry policy, or module path from the browser. `/-/rsc/action` is infrastructure transport only; service-to-service behavior remains under `messages/**`.

## Shutdown

Deactivate deployments, abort in-flight work, await runtime and catalog drains, detach internal operations, unregister artifacts after retention permits, then stop the single `HttpNext` server.
