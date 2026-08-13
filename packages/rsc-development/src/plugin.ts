import { watch } from 'node:fs';
import { watchRscDevelopmentState } from './state';
import { verifyRscPluginArtifact } from '@hile/rsc/artifact';
import type { RscRuntimeCompatibility } from '@hile/rsc/protocol';
import {
  createOfficialRscRenderer,
  RscArtifactServerFunctionRuntime,
  type RscPluginService,
} from '@hile/rsc/plugin';

export interface RscPluginDevelopmentBindingOptions {
  file: string;
  namespace: string;
  runtime: RscRuntimeCompatibility;
  onError?: (error: unknown) => void;
  pollMs?: number;
  verify?: typeof verifyRscPluginArtifact;
  createRenderer?: typeof createOfficialRscRenderer;
  createServerFunctions?: (artifactRoot: string) => RscArtifactServerFunctionRuntime;
  onActivated?: (record: import('./state').RscDevelopmentRevisionRecord) => void | Promise<void>;
}

/** Keeps one plugin microservice alive while atomically switching its RSC renderer revision. */
export async function bindRscPluginDevelopmentState(
  service: RscPluginService,
  options: RscPluginDevelopmentBindingOptions,
): Promise<() => Promise<void>> {
  let activeBuildId = service.describe().buildId;
  let announcedBuildId = activeBuildId;
  const verify = options.verify ?? verifyRscPluginArtifact;
  const createRenderer = options.createRenderer ?? createOfficialRscRenderer;
  const createServerFunctions = options.createServerFunctions
    ?? ((artifactRoot: string) => new RscArtifactServerFunctionRuntime(artifactRoot));
  const watcher = watchRscDevelopmentState(options.file, async (state) => {
    const record = state.revisions.find(({ namespace }) => namespace === options.namespace);
    if (!record) return;
    if (record.buildId !== activeBuildId) {
      const { manifest } = await verify(record.artifactRoot, options.runtime);
      if (manifest.pluginId !== record.pluginId || manifest.buildId !== record.buildId) {
        throw new Error(`RSC development artifact identity mismatch: ${record.pluginId}@${record.buildId}`);
      }
      service.activate({
        manifest,
        renderer: createRenderer(record.artifactRoot),
        serverFunctions: (manifest.serverFunctions?.length ?? 0) > 0
          ? createServerFunctions(record.artifactRoot)
          : undefined,
      });
      activeBuildId = record.buildId;
    }
    if (record.buildId !== announcedBuildId) {
      await options.onActivated?.({ ...record });
      announcedBuildId = record.buildId;
    }
  }, { onError: options.onError, pollMs: options.pollMs });
  try {
    await watcher.refresh();
  } catch (error) {
    await watcher.close();
    throw error;
  }
  return () => watcher.close();
}

export interface RscModelDevelopmentBinding {
  refresh(): Promise<void>;
  close(): Promise<void>;
}

/** Reloads only action models; RSC bundles and the microservice listener remain untouched. */
export function bindRscModelDevelopment(
  service: RscPluginService,
  directory: string,
  options: { debounceMs?: number; onError?: (error: unknown) => void } = {},
): RscModelDevelopmentBinding {
  let revision = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const refresh = () => {
    if (closed) return Promise.resolve();
    const apply = async () => { await service.load(directory, { cacheBust: ++revision }); };
    const result = queue.then(apply, apply);
    queue = result.catch((error) => options.onError?.(error));
    return result;
  };
  const watcher = watch(directory, { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void refresh().catch(() => undefined), options.debounceMs ?? 50);
  });
  return {
    refresh,
    async close() {
      if (closed) {
        await queue.catch(() => undefined);
        return;
      }
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
      await queue.catch(() => undefined);
    },
  };
}
