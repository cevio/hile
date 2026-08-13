import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import { createOfficialRscRenderer, RscPluginService } from '@hile/rsc/plugin';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import { attachRscPluginService } from '@hile/rsc/transport';
import { readRscDevelopmentState } from '@hile/rsc-development/state';
import { bindRscModelDevelopment, bindRscPluginDevelopmentState } from '@hile/rsc-development/plugin';

export default defineService('test.rsc.capabilities.v2', async (shutdown) => {
  const namespace = process.env.MICRO_NAMESPACE ?? 'demo.rsc.capabilities.v2';
  const developmentFile = process.env.RSC_DEVELOPMENT_STATE;
  const developmentRecord = developmentFile
    ? (await readRscDevelopmentState(developmentFile)).revisions.find((value) => value.namespace === namespace)
    : undefined;
  const artifactRoot = developmentRecord?.artifactRoot ?? path.resolve(process.env.RSC_ARTIFACT_ROOT ?? '.hile-rsc/v2');
  const { manifest } = await verifyRscPluginArtifact(artifactRoot, HILE_RSC_RUNTIME);
  const application = new Application({
    namespace,
    advertiseHost: process.env.HILE_ADVERTISE_HOST ?? '127.0.0.1',
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
  });
  const service = new RscPluginService({
    manifest,
    renderer: createOfficialRscRenderer(artifactRoot),
  });
  const modelsDirectory = fileURLToPath(new URL('../models', import.meta.url));
  await service.load(modelsDirectory);
  const modelDevelopment = developmentFile
    ? bindRscModelDevelopment(service, modelsDirectory, { onError: console.error })
    : undefined;
  const unbindDevelopment = developmentFile
    ? await bindRscPluginDevelopmentState(service, {
      file: developmentFile, namespace, runtime: HILE_RSC_RUNTIME, onError: console.error,
    })
    : () => undefined;
  const detach = attachRscPluginService(service, application);
  const stop = await application.listen(Number(process.env.PLUGIN_MICRO_PORT ?? 4212));
  shutdown(async () => {
    await unbindDevelopment();
    await modelDevelopment?.close();
    service.deactivate();
    await service.drain();
    detach();
    await stop();
  });
  return { application, service, manifest };
});
