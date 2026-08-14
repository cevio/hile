import { defineService } from '@hile/core';
import HttpNext from '@hile/http-next';
import { Application } from '@hile/micro';
import {
  createRscActionMiddleware,
  createSameOriginCsrfAuthorizer,
  RscActionGateway,
} from '@hile/rsc/host/actions';
import { createRscAssetMiddleware } from '@hile/rsc/host/assets';
import {
  createRscServerFunctionMiddleware,
  RscServerFunctionGateway,
} from '@hile/rsc/host/server-functions';
import {
  RscDevelopmentEvents,
  createRscDevelopmentEventMiddleware,
} from '@hile/rsc-development/host';
import {
  createCatalogRscPluginLocator,
  InMemoryRscDeploymentCatalog,
} from '@hile/rsc/host/catalog';
import { mountRscHostAdapters } from '@hile/rsc/host/mount';
import {
  createRemoteClientResolver,
  createRscAssetUrls,
  InMemoryRscArtifactCatalog,
  installRemoteClientResolver,
} from '@hile/rsc/host/registry';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import {
  attachRscDeploymentCatalog,
  createHileRscPluginClient,
} from '@hile/rsc/transport';
import { createHmacRscDiscoveryAuthorizer, HileRscDiscoveryHost } from '@hile/rsc-discovery-hile';
import {
  DEMO_HOST_SERVICE_KEY,
  installDemoHostComposition,
  type DemoHostComposition,
} from './runtime-reference';

const discoveryGenerationHighWater = new Map();

export default defineService<DemoHostComposition>(DEMO_HOST_SERVICE_KEY, async (shutdown) => {
  const hostRoot = process.cwd();
  const artifacts = new InMemoryRscArtifactCatalog();
  const deployments = new InMemoryRscDeploymentCatalog();
  const application = new Application({
    namespace: process.env.HOST_MICRO_NAMESPACE ?? 'demo.rsc.host',
    advertiseHost: process.env.HILE_ADVERTISE_HOST ?? '127.0.0.1',
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
  });
  const detachCatalog = attachRscDeploymentCatalog(deployments, application);
  const stopMicro = await application.listen(Number(process.env.HOST_MICRO_PORT ?? 4210));
  const locator = createCatalogRscPluginLocator(
    deployments,
    async (deployment) => createHileRscPluginClient(application, deployment.namespace),
  );
  const developmentEvents = new RscDevelopmentEvents();
  const developmentRevision = new Map<string, number>();
  const discovery = new HileRscDiscoveryHost({
    application,
    artifacts,
    deployments,
    runtime: HILE_RSC_RUNTIME,
    pollIntervalMs: Number(process.env.RSC_DISCOVERY_POLL_MS ?? 250),
    missingReconciliations: Number(process.env.RSC_DISCOVERY_MISSING_RECONCILIATIONS ?? 3),
    snapshotConcurrency: Number(process.env.RSC_DISCOVERY_SNAPSHOT_CONCURRENCY ?? 16),
    generationHighWater: discoveryGenerationHighWater,
    authorize: createHmacRscDiscoveryAuthorizer((keyId) => {
      if (keyId === 'demo-capabilities') return {
        secret: process.env.RSC_CAPABILITIES_DISCOVERY_SECRET ?? 'demo-capabilities-secret',
        pluginIds: ['demo.rsc.capabilities'],
        requireGeneration: true,
      };
      if (keyId === 'demo-isolation') return {
        secret: process.env.RSC_ISOLATION_DISCOVERY_SECRET ?? 'demo-isolation-secret',
        pluginIds: ['demo.rsc.isolation'],
        requireGeneration: true,
      };
      return undefined;
    }),
    onRejected: (topic, error) => console.error(`Rejected RSC discovery topic ${topic}`, error),
    onError: console.error,
    onEnabled: (announcement) => {
      const revision = (developmentRevision.get(announcement.pluginId) ?? 0) + 1;
      developmentRevision.set(announcement.pluginId, revision);
      developmentEvents.publish({
        pluginId: announcement.pluginId,
        buildId: announcement.buildId,
        revision,
      });
    },
  });
  try {
    await discovery.start();
  } catch (error) {
    await discovery.close().catch(() => undefined);
    detachCatalog();
    await stopMicro();
    throw error;
  }

  const assetMountPath = '/_hile/rsc/assets';
  const uninstallResolver = installRemoteClientResolver(
    createRemoteClientResolver(artifacts, createRscAssetUrls(assetMountPath)),
  );
  const authorize = createSameOriginCsrfAuthorizer({
    expectedOrigin: process.env.RSC_DEMO_ORIGIN ?? 'http://127.0.0.1:3200',
    readToken: (context) => {
      const entry = Object.entries(context.headers ?? {})
        .find(([name]) => name.toLowerCase() === 'x-rsc-demo-token')?.[1];
      return Array.isArray(entry) ? entry[0] : entry;
    },
    verifyToken: (token) => token === (process.env.RSC_DEMO_TOKEN ?? 'demo-token'),
  });
  const actionGateway = new RscActionGateway({ locator, authorize });
  const actionMiddleware = createRscActionMiddleware({ gateway: actionGateway });
  const serverFunctionGateway = new RscServerFunctionGateway({
    locator,
    authorize: (request, context) => authorize({
      pluginId: request.pluginId,
      buildId: request.buildId,
      actionId: request.referenceId,
      input: {},
    }, context),
  });
  const serverFunctionMiddleware = createRscServerFunctionMiddleware({ gateway: serverFunctionGateway });
  const host = new HttpNext({
    port: Number(process.env.HTTP_PORT ?? 3200),
    cwd: hostRoot,
  });
  mountRscHostAdapters(host, {
    asset: createRscAssetMiddleware({ catalog: artifacts, mountPath: assetMountPath }),
    action: async (context, next) => {
      context.requestContext = { headers: context.headers };
      return actionMiddleware(context, next);
    },
    serverFunction: async (context, next) => {
      context.requestContext = { headers: context.headers };
      return serverFunctionMiddleware(context, next);
    },
    middleware: process.env.RSC_DEVELOPMENT_STATE ? [
      createRscDevelopmentEventMiddleware({ events: developmentEvents }),
    ] : [],
  });
  const composition: DemoHostComposition = {
    application,
    deployments,
    discovery,
    locator,
    assetMountPath,
  };
  const uninstallComposition = installDemoHostComposition(composition);
  let stopHttp: () => Promise<void>;
  try {
    stopHttp = await host.start();
  } catch (error) {
    uninstallComposition();
    uninstallResolver();
    await discovery.close();
    detachCatalog();
    await stopMicro();
    throw error;
  }

  shutdown(async () => {
    uninstallComposition();
    uninstallResolver();
    await stopHttp();
    await discovery.close();
    detachCatalog();
    await stopMicro();
  });

  return composition;
});
