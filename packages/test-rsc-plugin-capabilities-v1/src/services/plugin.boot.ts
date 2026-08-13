import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineService } from '@hile/core';
import { Application } from '@hile/micro';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import { createOfficialRscRenderer, RscArtifactServerFunctionRuntime, RscPluginService } from '@hile/rsc/plugin';
import { HILE_RSC_RUNTIME } from '@hile/rsc/protocol';
import { readRscDevelopmentState } from '@hile/rsc-development/state';
import { bindRscModelDevelopment, bindRscPluginDevelopmentState } from '@hile/rsc-development/plugin';
import { HileRscPluginRuntime } from '@hile/rsc-discovery-hile';

export default defineService('test.rsc.capabilities.v1', async (shutdown) => {
  const namespace = process.env.MICRO_NAMESPACE ?? 'demo.rsc.capabilities.v1';
  const developmentFile = process.env.RSC_DEVELOPMENT_STATE;
  const developmentRecord = developmentFile
    ? (await readRscDevelopmentState(developmentFile)).revisions.find((value) => value.namespace === namespace)
    : undefined;
  const artifactRoot = developmentRecord?.artifactRoot ?? path.resolve(process.env.RSC_ARTIFACT_ROOT ?? '.hile-rsc/v1');
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
    serverFunctions: new RscArtifactServerFunctionRuntime(artifactRoot),
  });
  const modelsDirectory = fileURLToPath(new URL('../models', import.meta.url));
  await service.load(modelsDirectory);
  const modelDevelopment = developmentFile
    ? bindRscModelDevelopment(service, modelsDirectory, { onError: console.error })
    : undefined;
  const runtime = new HileRscPluginRuntime({
    application,
    service,
    port: Number(process.env.PLUGIN_MICRO_PORT ?? 4211),
    discovery: {
      namespace,
      instanceId: process.env.RSC_INSTANCE_ID ?? namespace,
      priority: Number(process.env.RSC_DISCOVERY_PRIORITY ?? 1),
      artifactRoot,
      authentication: {
        keyId: process.env.RSC_DISCOVERY_KEY_ID ?? 'demo-capabilities',
        secret: process.env.RSC_DISCOVERY_SECRET ?? 'demo-capabilities-secret',
      },
    },
    resources: modelDevelopment ? [modelDevelopment] : [],
    bindDevelopment: developmentFile
      ? async (publishArtifact) => bindRscPluginDevelopmentState(service, {
        file: developmentFile, namespace, runtime: HILE_RSC_RUNTIME, onError: console.error,
        onActivated: async (record) => { await publishArtifact(record.artifactRoot); },
      })
      : undefined,
  });
  await runtime.start();
  shutdown(() => runtime.close());
  return { application, service, manifest };
});
