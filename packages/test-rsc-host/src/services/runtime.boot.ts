import { defineService } from '@hile/core';
import HttpNext from '@hile/http-next';
import { Application } from '@hile/micro';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import {
  createRscActionMiddleware,
  createSameOriginCsrfAuthorizer,
  RscActionGateway,
} from '@hile/rsc/host/actions';
import { createRscAssetMiddleware } from '@hile/rsc/host/assets';
import {
  RscDevelopmentEvents,
  bindRscHostDevelopmentState,
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
import { DemoDeploymentController } from './demo-deployment-controller';
import { createDemoInventory } from './demo-inventory';
import {
  DEMO_HOST_SERVICE_KEY,
  installDemoHostComposition,
  type DemoHostComposition,
} from './runtime-reference';

export default defineService<DemoHostComposition>(DEMO_HOST_SERVICE_KEY, async (shutdown) => {
  const hostRoot = process.cwd();
  const inventory = createDemoInventory(hostRoot);
  const artifacts = new InMemoryRscArtifactCatalog();
  const unregisterArtifacts: Array<() => void> = [];
  for (const definition of inventory) {
    const { manifest } = await verifyRscPluginArtifact(definition.artifactRoot, HILE_RSC_RUNTIME);
    if (manifest.pluginId !== definition.pluginId || manifest.buildId !== definition.buildId) {
      throw new Error(`Demo artifact identity mismatch: ${definition.pluginId}@${definition.buildId}`);
    }
    unregisterArtifacts.push(artifacts.register(definition.artifactRoot, manifest));
  }

  const deployments = new InMemoryRscDeploymentCatalog();
  const lifecycle = new DemoDeploymentController(deployments, inventory, {
    mode: process.env.RSC_DEVELOPMENT_STATE ? 'development' : 'production',
  });
  lifecycle.initialize();

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
  const developmentEvents = new RscDevelopmentEvents();

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
    middleware: process.env.RSC_DEVELOPMENT_STATE ? [
      createRscDevelopmentEventMiddleware({ events: developmentEvents }),
    ] : [],
  });
  const composition: DemoHostComposition = {
    application,
    deployments,
    lifecycle,
    locator,
    assetMountPath,
    inventory,
  };
  const uninstallComposition = installDemoHostComposition(composition);
  const unbindDevelopment = process.env.RSC_DEVELOPMENT_STATE
    ? await bindRscHostDevelopmentState({
      file: process.env.RSC_DEVELOPMENT_STATE,
      application,
      artifacts,
      deployments,
      events: developmentEvents,
      runtime: HILE_RSC_RUNTIME,
      onError: console.error,
    })
    : () => undefined;
  let stopHttp: () => Promise<void>;
  try {
    stopHttp = await host.start();
  } catch (error) {
    uninstallComposition();
    throw error;
  }

  shutdown(async () => {
    await unbindDevelopment();
    uninstallComposition();
    uninstallResolver();
    detachCatalog();
    for (const snapshot of deployments.snapshot()) {
      deployments.deactivate(snapshot);
      await deployments.drain(snapshot);
      deployments.remove(snapshot);
    }
    for (const unregister of unregisterArtifacts.reverse()) unregister();
    await stopHttp();
    await stopMicro();
  });

  return composition;
});
