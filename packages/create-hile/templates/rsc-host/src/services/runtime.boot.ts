import path from 'node:path';
import { defineService, loadService } from '@hile/core';
import HttpNext from '@hile/http-next';
import { Application } from '@hile/micro';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import {
  InMemoryRscArtifactCatalog,
  createCatalogRscPluginLocator,
  createRemoteClientResolver,
  createRscAssetMiddleware,
  createRscAssetUrls,
  installRemoteClientResolver,
  mountRscHostAdapters,
} from '@hile/rsc/host';
import { createHileRscPluginClient } from '@hile/rsc/transport';
import {
  RscDevelopmentEvents,
  bindRscHostDevelopmentState,
  createRscDevelopmentEventMiddleware,
} from '@hile/rsc-development/host';
import catalogService from './catalog.boot';

export default defineService('rsc.host.runtime', async (shutdown) => {
  const { catalog: deployments } = await loadService(catalogService);
  const developmentFile = process.env.RSC_DEVELOPMENT_STATE
    ? path.resolve(process.env.RSC_DEVELOPMENT_STATE)
    : undefined;
  const artifactRoot = path.resolve(process.env.RSC_ARTIFACT_ROOT ?? '../rsc-plugin/.hile-rsc/build-a');
  const productionArtifact = developmentFile
    ? undefined
    : await verifyRscPluginArtifact(artifactRoot, HILE_RSC_RUNTIME);
  const namespace = process.env.RSC_PLUGIN_NAMESPACE
    ?? (productionArtifact ? `${productionArtifact.manifest.pluginId}.${productionArtifact.manifest.buildId}` : undefined);
  if (productionArtifact && namespace) {
    deployments.install({
      pluginId: productionArtifact.manifest.pluginId,
      buildId: productionArtifact.manifest.buildId,
      namespace,
    }, { activate: true });
  }

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

  const artifacts = new InMemoryRscArtifactCatalog();
  const unregisterArtifacts = productionArtifact
    ? artifacts.register(artifactRoot, productionArtifact.manifest)
    : () => undefined;
  const assetMountPath = process.env.RSC_ASSET_MOUNT ?? '/_hile/rsc/assets';
  const uninstallResolver = installRemoteClientResolver(
    createRemoteClientResolver(artifacts, createRscAssetUrls(assetMountPath)),
  );
  const host = new HttpNext({ port: Number(process.env.HTTP_PORT ?? 3000), cwd: process.cwd() });
  const developmentEvents = new RscDevelopmentEvents();
  mountRscHostAdapters(host, {
    asset: createRscAssetMiddleware({ catalog: artifacts, mountPath: assetMountPath }),
    middleware: developmentFile
      ? [createRscDevelopmentEventMiddleware({ events: developmentEvents })]
      : [],
  });
  const unbindDevelopment = developmentFile
    ? await bindRscHostDevelopmentState({
      file: developmentFile,
      application,
      artifacts,
      deployments,
      events: developmentEvents,
      runtime: HILE_RSC_RUNTIME,
      onError: console.error,
    })
    : async () => undefined;
  const stopHttp = await host.start();

  shutdown(async () => {
    await unbindDevelopment();
    for (const deployment of deployments.snapshot()) {
      if (deployment.state === 'active') deployments.deactivate(deployment);
      await deployments.drain(deployment);
      deployments.remove(deployment);
    }
    uninstallResolver();
    unregisterArtifacts();
    await stopHttp();
    await stopMicro();
  });
  return { deployments, locator, assetMountPath };
});
