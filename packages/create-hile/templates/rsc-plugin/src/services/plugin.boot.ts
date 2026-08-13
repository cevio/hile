import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import {
  RscPluginService,
  RscArtifactServerFunctionRuntime,
  createOfficialRscRenderer,
} from '@hile/rsc/plugin';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import { HileRscPluginRuntime } from '@hile/rsc-discovery-hile';

export default defineService('rsc.plugin.runtime', async (shutdown) => {
  const namespace = process.env.MICRO_NAMESPACE ?? 'org.example.rsc-plugin.dev';
  const developmentFile = process.env.RSC_DEVELOPMENT_STATE;
  const developmentState = developmentFile ? await import('@hile/rsc-development/state') : undefined;
  const developmentBinding = developmentFile ? await import('@hile/rsc-development/plugin') : undefined;
  const developmentRecord = developmentFile
    ? (await developmentState!.readRscDevelopmentState(developmentFile)).revisions.find((record) => record.namespace === namespace)
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
    serverFunctions: new RscArtifactServerFunctionRuntime(artifactRoot),
  });
  const modelsDirectory = fileURLToPath(new URL('../models', import.meta.url));
  await service.load(modelsDirectory);
  const modelDevelopment = developmentFile
    ? developmentBinding!.bindRscModelDevelopment(service, modelsDirectory, { onError: console.error })
    : undefined;
  const runtime = new HileRscPluginRuntime({
    application,
    service,
    port: Number(process.env.PLUGIN_MICRO_PORT ?? 4101),
    discovery: {
      namespace,
      instanceId: process.env.RSC_INSTANCE_ID ?? namespace,
      priority: Number(process.env.RSC_DISCOVERY_PRIORITY ?? 0),
      artifactRoot,
      authentication: {
        keyId: process.env.RSC_DISCOVERY_KEY_ID ?? '',
        secret: process.env.RSC_DISCOVERY_SECRET ?? '',
      },
    },
    resources: modelDevelopment ? [modelDevelopment] : [],
    bindDevelopment: developmentFile
      ? async (publishArtifact) => developmentBinding!.bindRscPluginDevelopmentState(service, {
        file: developmentFile, namespace, runtime: HILE_RSC_RUNTIME, onError: console.error,
        onActivated: async (record) => { await publishArtifact(record.artifactRoot); },
      })
      : undefined,
  });
  await runtime.start();
  shutdown(() => runtime.close());
  return { application, service, manifest };
});
