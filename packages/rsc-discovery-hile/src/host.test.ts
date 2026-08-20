import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InMemoryRscArtifactCatalog } from '@hile/rsc/host/registry';
import { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import { listActiveRscPlugins } from '@hile/rsc/host/plugin-metadata';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import { createTrustedInternalRscDiscoveryAuthorizer } from './authentication';
import { HileRscDiscoveryHost } from './host';
import type { RscDiscoveryGenerationHighWater } from '@hile/rsc-discovery';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifact(buildId: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-discovery-host-test-'));
  roots.push(root);
  const server = Buffer.from(`export default ${JSON.stringify(buildId)}`);
  const manifest: RscPluginManifest = {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: {
      entry: 'server/index.js',
      integrity: `sha256-${createHash('sha256').update(server).digest('base64')}`,
    },
    serverFunctions: [],
    clients: [], styles: [], routes: [{ path: '/', entry: 'default' }],
    metadata: {
      displayName: `Fixture ${buildId}`,
      navigation: [{ id: 'home', label: 'Home', path: '/' }],
    },
  };
  await mkdir(path.join(root, 'server'));
  await writeFile(path.join(root, manifest.server.entry), server);
  await writeFile(path.join(root, 'plugin.json'), JSON.stringify(manifest));
  return { manifest, server };
}

function announcement(manifest: RscPluginManifest, priority: number) {
  return {
    schemaVersion: 1 as const,
    capability: '@hile/rsc' as const,
    instanceId: `instance-${manifest.buildId}`,
    pluginId: manifest.pluginId,
    buildId: manifest.buildId,
    namespace: `fixture.${manifest.buildId}`,
    priority,
    protocolVersion: 1 as const,
    runtime: manifest.runtime,
    artifactOperation: '/-/rsc/artifact',
    authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
  };
}

function artifactStream(getArtifact: () => Awaited<ReturnType<typeof artifact>>) {
  return vi.fn(async (_namespace: string, _operation: string, data: any) => {
    const value = getArtifact();
    if (data.path === 'plugin.json') {
      return Readable.from([Buffer.from(JSON.stringify(value.manifest))]);
    }
    expect(data.path).toBe(value.manifest.server.entry);
    return Readable.from([value.server]);
  });
}

describe('HileRscDiscoveryHost', () => {
  it('deploys an unsigned announcement only through the explicit trusted-internal policy', async () => {
    const value = await artifact('build-trusted');
    const discovered = {
      ...announcement(value.manifest, 1),
      authentication: { scheme: 'trusted-internal' as const },
    };
    const application = {
      listRegistryTopics: vi.fn(async () => [{
        topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`,
        hasData: true,
      }]),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: discovered })),
      stream: artifactStream(() => value),
    };
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments,
      runtime: value.manifest.runtime,
      authorize: createTrustedInternalRscDiscoveryAuthorizer(),
    });

    await host.refresh();
    expect(deployments.getActive(value.manifest.pluginId)?.buildId).toBe('build-trusted');
    await host.close();
  });

  it('automatically stages, enables, upgrades and unregisters Registry-discovered services', async () => {
    const v1 = await artifact('build-v1');
    const v2 = await artifact('build-v2');
    let current = announcement(v1.manifest, 1);
    let currentArtifact = v1;
    let present = true;
    const application = {
      listRegistryTopics: vi.fn(async () => present ? [{
        topic: `@hile/rsc/discovery/v1/${current.instanceId}`,
        hasData: true,
      }] : []),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: current })),
      stream: artifactStream(() => currentArtifact),
    };
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts,
      deployments,
      runtime: v1.manifest.runtime,
      authorize: async () => true,
      missingReconciliations: 1,
    });

    await host.refresh();
    expect(deployments.getActive(v1.manifest.pluginId)?.buildId).toBe('build-v1');
    expect(artifacts.get(v1.manifest.pluginId, 'build-v1')).toBeDefined();

    current = announcement(v2.manifest, 2);
    currentArtifact = v2;
    await host.refresh();
    expect(deployments.getActive(v2.manifest.pluginId)?.buildId).toBe('build-v2');
    expect(listActiveRscPlugins(deployments, artifacts)).toEqual([{
      pluginId: v2.manifest.pluginId,
      buildId: 'build-v2',
      namespace: 'fixture.build-v2',
      metadata: v2.manifest.metadata,
    }]);
    expect(deployments.snapshot().some(({ buildId }) => buildId === 'build-v1')).toBe(false);

    present = false;
    await host.refresh();
    expect(deployments.snapshot()).toEqual([]);
    expect(host.snapshot()).toEqual([]);
    await host.close();
  });

  it('keeps the active deployment when Registry itself is temporarily unavailable', async () => {
    const value = await artifact('build-v1');
    const discovered = announcement(value.manifest, 1);
    let registryAvailable = true;
    const application = {
      listRegistryTopics: vi.fn(async () => {
        if (!registryAvailable) throw new Error('registry offline');
        return [{ topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`, hasData: true }];
      }),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: discovered })),
      stream: artifactStream(() => value),
    };
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments,
      runtime: value.manifest.runtime,
      authorize: async () => true,
    });
    await host.refresh();
    registryAvailable = false;
    await expect(host.refresh()).rejects.toThrow('registry offline');
    expect(deployments.getActive(value.manifest.pluginId)?.buildId).toBe('build-v1');
    await host.close();
  });

  it('keeps the active build when a discovered replacement has invalid metadata', async () => {
    const v1 = await artifact('build-v1');
    const v2 = await artifact('build-v2');
    let current = announcement(v1.manifest, 1);
    let currentArtifact = v1;
    const application = {
      listRegistryTopics: vi.fn(async () => [{
        topic: `@hile/rsc/discovery/v1/${current.instanceId}`,
        hasData: true,
      }]),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: current })),
      stream: artifactStream(() => currentArtifact),
    };
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts,
      deployments,
      runtime: v1.manifest.runtime,
      authorize: async () => true,
    });
    await host.refresh();

    v2.manifest.metadata!.navigation[0].path = '/missing';
    current = announcement(v2.manifest, 2);
    currentArtifact = v2;
    await expect(host.refresh()).rejects.toThrow('reconciliation failed');
    expect(listActiveRscPlugins(deployments, artifacts)).toEqual([{
      pluginId: v1.manifest.pluginId,
      buildId: v1.manifest.buildId,
      namespace: 'fixture.build-v1',
      metadata: v1.manifest.metadata,
    }]);
    await host.close();
  });

  it('keeps observer failures outside the deployment transaction', async () => {
    const value = await artifact('build-v1');
    const discovered = announcement(value.manifest, 1);
    const observerError = new Error('reload observer failed');
    const onError = vi.fn();
    const application = {
      listRegistryTopics: vi.fn(async () => [{
        topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`,
        hasData: true,
      }]),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: discovered })),
      stream: artifactStream(() => value),
    };
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments,
      runtime: value.manifest.runtime,
      authorize: async () => true,
      onEnabled: async () => { throw observerError; },
      onError,
    });

    await host.refresh();
    expect(deployments.getActive(value.manifest.pluginId)?.buildId).toBe('build-v1');
    expect(host.snapshot()[0]).toMatchObject({ buildId: 'build-v1', state: 'enabled' });
    expect(onError).toHaveBeenCalledWith(observerError);
    await host.close();
  });

  it('coalesces overlapping refreshes and rejects unauthorized announcements', async () => {
    const value = await artifact('build-v1');
    const discovered = announcement(value.manifest, 1);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const onRejected = vi.fn();
    const application = {
      listRegistryTopics: vi.fn(async () => {
        await gate;
        return [{ topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`, hasData: true }];
      }),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: discovered })),
      stream: vi.fn(),
    };
    const deployments = new InMemoryRscDeploymentCatalog();
    const host = new HileRscDiscoveryHost({
      application,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments,
      runtime: value.manifest.runtime,
      authorize: async () => false,
      onRejected,
    });
    const first = host.refresh();
    const second = host.refresh();
    release();
    await Promise.all([first, second]);
    expect(application.listRegistryTopics).toHaveBeenCalledOnce();
    expect(onRejected).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining('Unauthorized') }));
    expect(deployments.snapshot()).toEqual([]);
    await host.close();
  });

  it('allows cleanup to be retried after a transient close failure', async () => {
    const value = await artifact('build-v1');
    const host = new HileRscDiscoveryHost({
      application: {
        listRegistryTopics: vi.fn(async () => []),
        getRegistryTopic: vi.fn(),
        stream: vi.fn(),
      },
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments: new InMemoryRscDeploymentCatalog(),
      runtime: value.manifest.runtime,
      authorize: async () => true,
    });
    const discovery = (host as unknown as { discovery: { close(): Promise<void> } }).discovery;
    const original = discovery.close.bind(discovery);
    const close = vi.spyOn(discovery, 'close')
      .mockRejectedValueOnce(new Error('temporary discovery cleanup failure'))
      .mockImplementation(original);

    await expect(host.close()).rejects.toThrow('cleanup failed');
    await expect(host.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('does not report an intentionally aborted polling refresh during close', async () => {
    const value = await artifact('build-v1');
    let calls = 0;
    let secondRefresh!: () => void;
    const secondStarted = new Promise<void>((resolve) => { secondRefresh = resolve; });
    const onError = vi.fn();
    const host = new HileRscDiscoveryHost({
      application: {
        listRegistryTopics: vi.fn(async () => {
          calls += 1;
          if (calls === 1) return [];
          secondRefresh();
          return new Promise<never>(() => undefined);
        }),
        getRegistryTopic: vi.fn(),
        stream: vi.fn(),
      },
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments: new InMemoryRscDeploymentCatalog(),
      runtime: value.manifest.runtime,
      pollIntervalMs: 25,
      authorize: async () => true,
      onError,
    });

    await host.start();
    await secondStarted;
    await host.close();
    expect(onError).not.toHaveBeenCalled();
  });

  it('does not start another snapshot while an aborted Registry read is still settling', async () => {
    const value = await artifact('build-v1');
    const discovered = announcement(value.manifest, 1);
    const getRegistryTopic = vi.fn(() => new Promise<never>(() => undefined));
    const host = new HileRscDiscoveryHost({
      application: {
        listRegistryTopics: vi.fn(async () => [{
          topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`,
          hasData: true,
        }]),
        getRegistryTopic,
        stream: vi.fn(),
      },
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments: new InMemoryRscDeploymentCatalog(),
      runtime: value.manifest.runtime,
      authorize: async () => true,
      operationTimeoutMs: 100,
    });

    await expect(host.refresh()).rejects.toThrow('timed out');
    await expect(host.refresh()).rejects.toThrow('still settling');
    expect(getRegistryTopic).toHaveBeenCalledOnce();
    await host.close();
  });

  it('retains generation replay protection when a Host is recreated with the same store', async () => {
    const value = await artifact('build-v1');
    let discovered = { ...announcement(value.manifest, 1), generation: 9 };
    const application = {
      listRegistryTopics: vi.fn(async () => [{
        topic: `@hile/rsc/discovery/v1/${discovered.instanceId}`,
        hasData: true,
      }]),
      getRegistryTopic: vi.fn(async () => ({ hasData: true, payload: discovered })),
      stream: artifactStream(() => value),
    };
    const generationHighWater = new Map<string, RscDiscoveryGenerationHighWater>();
    const createHost = () => new HileRscDiscoveryHost({
      application,
      artifacts: new InMemoryRscArtifactCatalog(),
      deployments: new InMemoryRscDeploymentCatalog(),
      runtime: value.manifest.runtime,
      authorize: async () => true,
      generationHighWater,
    });
    const first = createHost();
    await first.refresh();
    await first.close();

    discovered = { ...discovered, generation: 8 };
    const second = createHost();
    await expect(second.refresh()).rejects.toThrow('generation rollback');
    expect(second.snapshot()).toEqual([]);
    await second.close();
  });
});
