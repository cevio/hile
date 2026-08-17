import { describe, expect, it } from 'vitest';
import type { RscPluginManifest } from '../protocol';
import { InMemoryRscDeploymentCatalog } from './catalog';
import { listActiveRscPlugins } from './plugin-metadata';
import { InMemoryRscArtifactCatalog, type RscArtifactCatalog } from './registry';

function manifest(pluginId: string, buildId: string, displayName: string): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId,
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server-rsc/index.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [],
    styles: [],
    routes: [{ path: '/', entry: 'default' }],
    metadata: {
      displayName,
      navigation: [{ id: 'home', label: displayName, path: '/', order: 10 }],
    },
  };
}

describe('listActiveRscPlugins', () => {
  it('lists only active plugins in deterministic plugin identity order', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    const artifacts = new InMemoryRscArtifactCatalog();
    for (const [pluginId, active] of [
      ['org.hile.zeta', true],
      ['org.hile.staged', false],
      ['org.hile.alpha', true],
    ] as const) {
      const value = manifest(pluginId, 'build-a', pluginId);
      artifacts.register(`/tmp/${pluginId}`, value);
      deployments.install({
        pluginId, buildId: value.buildId, namespace: `${pluginId}.runtime`,
      }, { activate: active });
    }

    expect(listActiveRscPlugins(deployments, artifacts).map(({ pluginId }) => pluginId))
      .toEqual(['org.hile.alpha', 'org.hile.zeta']);
  });

  it('joins only active deployments with their immutable manifest metadata', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    const artifacts = new InMemoryRscArtifactCatalog();
    const buildA = manifest('org.hile.analytics', 'build-a', 'Analytics A');
    const buildB = manifest('org.hile.analytics', 'build-b', 'Analytics B');
    artifacts.register('/tmp/build-a', buildA);
    artifacts.register('/tmp/build-b', buildB);
    deployments.install({ pluginId: buildA.pluginId, buildId: buildA.buildId, namespace: 'analytics.a' }, { activate: true });
    deployments.install({ pluginId: buildB.pluginId, buildId: buildB.buildId, namespace: 'analytics.b' }, { activate: true });

    const listed = listActiveRscPlugins(deployments, artifacts);
    listed[0].metadata!.navigation[0].label = 'mutated';

    expect(listActiveRscPlugins(deployments, artifacts)).toEqual([{
      pluginId: buildB.pluginId,
      buildId: buildB.buildId,
      namespace: 'analytics.b',
      metadata: buildB.metadata,
    }]);
  });

  it('keeps legacy active plugins discoverable without inventing presentation data', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    const artifacts = new InMemoryRscArtifactCatalog();
    const legacy = manifest('org.hile.legacy', 'build-a', 'Legacy');
    delete legacy.metadata;
    artifacts.register('/tmp/legacy', legacy);
    deployments.install({
      pluginId: legacy.pluginId, buildId: legacy.buildId, namespace: 'legacy.runtime',
    }, { activate: true });

    expect(listActiveRscPlugins(deployments, artifacts)).toEqual([{
      pluginId: legacy.pluginId,
      buildId: legacy.buildId,
      namespace: 'legacy.runtime',
    }]);
  });

  it('defensively copies metadata regardless of the artifact catalog implementation', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    const source = manifest('org.hile.mutable', 'build-a', 'Mutable source');
    const artifacts: RscArtifactCatalog = {
      get: () => ({ root: '/tmp/mutable', manifest: source }),
    };
    deployments.install({
      pluginId: source.pluginId, buildId: source.buildId, namespace: 'mutable.runtime',
    }, { activate: true });

    const listed = listActiveRscPlugins(deployments, artifacts);
    listed[0].metadata!.displayName = 'consumer mutation';
    listed[0].metadata!.navigation[0].label = 'consumer mutation';

    expect(source.metadata).toEqual({
      displayName: 'Mutable source',
      navigation: [{ id: 'home', label: 'Mutable source', path: '/', order: 10 }],
    });
  });

  it('fails closed when an active deployment has no matching artifact manifest', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    deployments.install({
      pluginId: 'org.hile.missing', buildId: 'build-a', namespace: 'missing.runtime',
    }, { activate: true });

    expect(() => listActiveRscPlugins(deployments, new InMemoryRscArtifactCatalog()))
      .toThrow('Active RSC plugin artifacts are missing');
  });

  it('fails closed when an artifact catalog returns a manifest for another identity', () => {
    const deployments = new InMemoryRscDeploymentCatalog();
    const wrong = manifest('org.hile.wrong', 'build-b', 'Wrong plugin');
    deployments.install({
      pluginId: 'org.hile.expected', buildId: 'build-a', namespace: 'expected.runtime',
    }, { activate: true });

    expect(() => listActiveRscPlugins(deployments, {
      get: () => ({ root: '/tmp/wrong', manifest: wrong }),
    })).toThrow('RSC plugin artifact identity mismatch');
  });
});
