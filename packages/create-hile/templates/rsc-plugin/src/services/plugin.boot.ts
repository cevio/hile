import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import {
  RscPluginService,
  createOfficialRscRenderer,
} from '@hile/rsc/plugin';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import { readRscDevelopmentState } from '@hile/rsc-development/state';
import { bindRscModelDevelopment, bindRscPluginDevelopmentState } from '@hile/rsc-development/plugin';
import { attachRscPluginService } from '@hile/rsc/transport';

export default defineService('rsc.plugin.runtime', async (shutdown) => {
  const namespace = process.env.MICRO_NAMESPACE ?? 'org.example.rsc-plugin.dev';
  const developmentFile = process.env.RSC_DEVELOPMENT_STATE;
  const developmentRecord = developmentFile
    ? (await readRscDevelopmentState(developmentFile)).revisions.find((record) => record.namespace === namespace)
    : undefined;
  const artifactRoot = developmentRecord?.artifactRoot ?? path.resolve(process.env.RSC_ARTIFACT_ROOT ?? '.hile-rsc/build-a');
  const { manifest } = await verifyRscPluginArtifact(artifactRoot, HILE_RSC_RUNTIME);
  const application = new Application({
    namespace,
    registry: {
      host: process.env.REGISTRY_HOST ?? '127.0.0.1',
      port: Number(process.env.REGISTRY_PORT ?? 9876),
    },
    ...(process.env.HILE_ADVERTISE_HOST
      ? { advertiseHost: process.env.HILE_ADVERTISE_HOST }
      : {}),
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
    : async () => undefined;
  const detach = attachRscPluginService(service, application);
  const port = Number(process.env.PLUGIN_MICRO_PORT ?? 4101);
  const stop = await application.listen(port);

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
