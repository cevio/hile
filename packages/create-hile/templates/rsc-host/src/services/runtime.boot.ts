import { defineService } from '@hile/core';
import HttpNext from '@hile/http-next';
import { Application } from '@hile/micro';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import {
  InMemoryRscDeploymentCatalog,
  InMemoryRscArtifactCatalog,
  createCatalogRscPluginLocator,
  createRemoteClientResolver,
  createRscAssetMiddleware,
  createRscAssetUrls,
  installRemoteClientResolver,
  mountRscHostAdapters,
  createSameOriginCsrfAuthorizer,
  createRscServerFunctionMiddleware,
  RscServerFunctionGateway,
} from '@hile/rsc/host';
import { createHileRscPluginClient } from '@hile/rsc/transport';
import { createHmacRscDiscoveryAuthorizer, HileRscDiscoveryHost } from '@hile/rsc-discovery-hile';

export default defineService('rsc.host.runtime', async (shutdown) => {
  const artifacts = new InMemoryRscArtifactCatalog();
  const deployments = new InMemoryRscDeploymentCatalog();
  const application = new Application({
    namespace: process.env.HOST_MICRO_NAMESPACE ?? 'com.hile.rsc.host',
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
  });
  const stopMicro = await application.listen(Number(process.env.HOST_MICRO_PORT ?? 4103));
  const locator = createCatalogRscPluginLocator(
    deployments,
    async (deployment) => createHileRscPluginClient(application, deployment.namespace),
  );

  const assetMountPath = process.env.RSC_ASSET_MOUNT ?? '/_hile/rsc/assets';
  const uninstallResolver = installRemoteClientResolver(
    createRemoteClientResolver(artifacts, createRscAssetUrls(assetMountPath)),
  );
  const development = process.env.NODE_ENV === 'development'
    ? await import('@hile/rsc-development/host')
    : undefined;
  const developmentEvents = development ? new development.RscDevelopmentEvents() : undefined;
  const revisions = new Map<string, number>();
  const discovery = new HileRscDiscoveryHost({
    application,
    artifacts,
    deployments,
    runtime: HILE_RSC_RUNTIME,
    pollIntervalMs: Number(process.env.RSC_DISCOVERY_POLL_MS ?? 500),
    missingReconciliations: Number(process.env.RSC_DISCOVERY_MISSING_RECONCILIATIONS ?? 3),
    authorize: createHmacRscDiscoveryAuthorizer((keyId) => {
      if (keyId !== process.env.RSC_DISCOVERY_KEY_ID || !process.env.RSC_DISCOVERY_SECRET) return undefined;
      const pluginIds = (process.env.RSC_DISCOVERY_PLUGIN_IDS ?? '')
        .split(',').map((value) => value.trim()).filter(Boolean);
      return { secret: process.env.RSC_DISCOVERY_SECRET, pluginIds };
    }),
    onRejected: (topic, error) => console.error(`Rejected RSC discovery topic ${topic}`, error),
    onError: console.error,
    onEnabled: process.env.NODE_ENV === 'development' ? (announcement) => {
      const revision = (revisions.get(announcement.pluginId) ?? 0) + 1;
      revisions.set(announcement.pluginId, revision);
      developmentEvents?.publish({
        pluginId: announcement.pluginId,
        buildId: announcement.buildId,
        revision,
      });
    } : undefined,
  });
  const host = new HttpNext({ port: Number(process.env.HTTP_PORT ?? 3000), cwd: process.cwd() });
  const csrf = createSameOriginCsrfAuthorizer({
    expectedOrigin: process.env.RSC_HOST_ORIGIN ?? 'http://127.0.0.1:3000',
    readToken: (context) => {
      const value = context.headers?.['x-rsc-csrf-token'];
      return Array.isArray(value) ? value[0] : value;
    },
    verifyToken: (token) => token === process.env.RSC_CSRF_TOKEN,
  });
  const serverFunctions = createRscServerFunctionMiddleware({
    gateway: new RscServerFunctionGateway({
      locator,
      authorize: (request, context) => csrf({
        pluginId: request.pluginId,
        buildId: request.buildId,
        actionId: request.referenceId,
        input: {},
      }, context),
    }),
  });
  mountRscHostAdapters(host, {
    asset: createRscAssetMiddleware({ catalog: artifacts, mountPath: assetMountPath }),
    serverFunction: async (context, next) => {
      context.requestContext = { headers: context.headers };
      return serverFunctions(context, next);
    },
    middleware: development && developmentEvents
      ? [development.createRscDevelopmentEventMiddleware({ events: developmentEvents })]
      : [],
  });
  let stopHttp: (() => Promise<void>) | undefined;
  try {
    await discovery.start();
    stopHttp = await host.start();
  } catch (error) {
    await discovery.close().catch(() => undefined);
    uninstallResolver();
    await stopMicro();
    throw error;
  }

  shutdown(async () => {
    await stopHttp?.();
    await discovery.close();
    uninstallResolver();
    await stopMicro();
  });
  return { deployments, discovery, locator, assetMountPath };
});
