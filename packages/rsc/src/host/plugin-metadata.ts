import type { RscPluginMetadata } from '../protocol';
import type { RscDeploymentSnapshot } from './catalog';
import type { RscArtifactCatalog } from './registry';

export interface RscActivePluginDescriptor {
  pluginId: string;
  buildId: string;
  namespace: string;
  metadata?: RscPluginMetadata;
}

export interface RscLocalDeploymentSnapshotSource {
  snapshot(): RscDeploymentSnapshot[];
}

/**
 * Derives the active plugin view from lifecycle state and immutable artifacts.
 * No second catalog is retained, so activation and rollback stay atomic.
 */
export function listActiveRscPlugins(
  deployments: RscLocalDeploymentSnapshotSource,
  artifacts: RscArtifactCatalog,
): RscActivePluginDescriptor[] {
  return deployments.snapshot()
    .filter(({ state }) => state === 'active')
    .map(({ pluginId, buildId, namespace }) => {
      const registered = artifacts.get(pluginId, buildId);
      if (!registered) {
        throw new Error(`Active RSC plugin artifacts are missing: ${pluginId}@${buildId}`);
      }
      if (
        registered.manifest.pluginId !== pluginId
        || registered.manifest.buildId !== buildId
      ) {
        throw new Error(`RSC plugin artifact identity mismatch: ${pluginId}@${buildId}`);
      }
      return {
        pluginId,
        buildId,
        namespace,
        ...(registered.manifest.metadata === undefined
          ? {}
          : { metadata: structuredClone(registered.manifest.metadata) }),
      };
    })
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}
