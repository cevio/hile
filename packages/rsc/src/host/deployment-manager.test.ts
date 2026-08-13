import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest, RscRuntimeCompatibility } from '../protocol';
import { InMemoryRscArtifactCatalog } from './registry';
import { InMemoryRscDeploymentCatalog } from './catalog';
import {
  RscDeploymentManager,
  stageRscPluginArtifact,
  type RscManagedPluginRuntime,
} from './deployment-manager';

const runtime: RscRuntimeCompatibility = { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' };

function manifest(buildId: string): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId,
    runtime,
    server: { entry: 'server-rsc/index.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [], styles: [], routes: [{ path: '/fixture', entry: 'default' }],
  };
}

function managedRuntime(): RscManagedPluginRuntime {
  return {
    deactivate: vi.fn(),
    drain: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
  };
}

const stage = async (artifactRoot: string, verification: any) => ({
  artifactRoot,
  verification,
  cleanup: vi.fn(),
});

function setup() {
  const artifacts = new InMemoryRscArtifactCatalog();
  const deployments = new InMemoryRscDeploymentCatalog();
  const runtimes = new Map<string, RscManagedPluginRuntime>();
  const verify = vi.fn(async (root: string) => ({
    manifest: manifest(root.endsWith('b') ? 'build-b' : 'build-a'), files: [],
  }));
  const start = vi.fn(async ({ deployment }: any) => {
    const value = managedRuntime();
    runtimes.set(deployment.buildId, value);
    return value;
  });
  const manager = new RscDeploymentManager({ artifacts, deployments, runtime, verify, stage, start });
  return { manager, artifacts, deployments, runtimes, verify, start };
}

describe('RscDeploymentManager', () => {
  it('stages an immutable verified copy independent from later source mutations', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-stage-test-'));
    const server = Buffer.from('export default 1');
    const value = manifest('build-stage');
    value.server.entry = 'server-rsc-index.js';
    value.server.integrity = `sha256-${createHash('sha256').update(server).digest('base64')}`;
    await writeFile(path.join(root, value.server.entry), server);
    await writeFile(path.join(root, 'plugin.json'), JSON.stringify(value));

    const staged = await stageRscPluginArtifact(
      root,
      { manifest: value, files: [value.server.entry] },
      runtime,
    );
    await writeFile(path.join(root, value.server.entry), 'mutated');

    expect(await readFile(path.join(staged.artifactRoot, value.server.entry), 'utf8'))
      .toBe('export default 1');
    await staged.cleanup();
    await rm(root, { recursive: true, force: true });
  });

  it('verifies, starts, registers and activates a build transactionally', async () => {
    const { manager, artifacts, deployments, start } = setup();
    await expect(manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true }))
      .resolves.toEqual({ pluginId: 'org.hile.fixture', buildId: 'build-a', namespace: 'runtime.a' });

    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      artifactRoot: '/artifact-a',
      deployment: { pluginId: 'org.hile.fixture', buildId: 'build-a', namespace: 'runtime.a' },
    }));
    expect(artifacts.get('org.hile.fixture', 'build-a')).toBeDefined();
    expect(deployments.getActive('org.hile.fixture')?.buildId).toBe('build-a');
  });

  it('rolls back runtime, artifacts and catalog when installation fails', async () => {
    const { manager, artifacts, deployments, start } = setup();
    const runtime = managedRuntime();
    start.mockResolvedValueOnce(runtime).mockRejectedValueOnce(new Error('start failed'));
    await manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' });
    await expect(manager.install({ artifactRoot: '/artifact-b', namespace: 'runtime.b' }))
      .rejects.toThrow('start failed');
    expect(artifacts.get('org.hile.fixture', 'build-b')).toBeUndefined();
    expect(deployments.snapshot().map(({ buildId }) => buildId)).toEqual(['build-a']);
  });

  it('cleans the staged artifact when artifact registration fails', async () => {
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    artifacts.register('/existing', manifest('build-a'));
    const cleanup = vi.fn();
    const manager = new RscDeploymentManager({
      artifacts,
      deployments,
      runtime,
      verify: async () => ({ manifest: manifest('build-a'), files: [] }),
      stage: async (artifactRoot, verification) => ({ artifactRoot, verification, cleanup }),
      start: async () => managedRuntime(),
    });
    await expect(manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' }))
      .rejects.toThrow('already registered');
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('continues installation rollback when a runtime cleanup step fails', async () => {
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    deployments.install({
      pluginId: 'org.hile.fixture', buildId: 'build-a', namespace: 'existing.runtime',
    });
    const runtimeValue = managedRuntime();
    vi.mocked(runtimeValue.deactivate).mockRejectedValueOnce(new Error('deactivate failed'));
    const manager = new RscDeploymentManager({
      artifacts,
      deployments,
      runtime,
      verify: async () => ({ manifest: manifest('build-a'), files: [] }),
      stage,
      start: async () => runtimeValue,
    });

    await expect(manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' }))
      .rejects.toThrow('cleanup reported errors');
    expect(runtimeValue.drain).toHaveBeenCalledOnce();
    expect(runtimeValue.stop).toHaveBeenCalledOnce();
    expect(artifacts.get('org.hile.fixture', 'build-a')).toBeUndefined();
  });

  it('upgrades new requests immediately and retires the old runtime only after leases drain', async () => {
    const { manager, deployments, runtimes } = setup();
    const old = await manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true });
    const lease = deployments.acquire(old);
    const upgrade = manager.upgrade({ artifactRoot: '/artifact-b', namespace: 'runtime.b' });
    const next = await upgrade;

    expect(next.buildId).toBe('build-b');
    expect(deployments.getActive(old.pluginId)?.buildId).toBe('build-b');
    let retired = false;
    const retire = manager.retire(old).then(() => { retired = true; });
    await Promise.resolve();
    expect(retired).toBe(false);
    expect(runtimes.get('build-a')!.deactivate).not.toHaveBeenCalled();
    lease.release();
    await retire;
    expect(runtimes.get('build-a')!.deactivate).toHaveBeenCalledOnce();
    expect(runtimes.get('build-a')!.drain).toHaveBeenCalledOnce();
    expect(runtimes.get('build-a')!.stop).toHaveBeenCalledOnce();
  });

  it('can retain immutable artifacts while removing runtime state', async () => {
    const { manager, artifacts, deployments } = setup();
    const deployment = await manager.install({
      artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true,
    });
    await manager.deactivate(deployment);
    await manager.retire(deployment, { removeArtifacts: false });
    expect(deployments.snapshot()).toEqual([]);
    expect(artifacts.get(deployment.pluginId, deployment.buildId)).toBeDefined();
  });

  it('rejects manifest/deployment identity mismatch before starting a runtime', async () => {
    const { manager, start } = setup();
    await expect(manager.install({
      artifactRoot: '/artifact-a', namespace: 'runtime.a',
      expected: { pluginId: 'org.hile.other', buildId: 'build-a' },
    })).rejects.toThrow('identity mismatch');
    expect(start).not.toHaveBeenCalled();
  });

  it('shuts down all managed builds idempotently', async () => {
    const { manager, deployments, runtimes } = setup();
    await manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true });
    await manager.install({ artifactRoot: '/artifact-b', namespace: 'runtime.b' });
    await manager.shutdown();
    await manager.shutdown();
    expect(deployments.snapshot()).toEqual([]);
    for (const value of runtimes.values()) expect(value.stop).toHaveBeenCalledOnce();
  });

  it('continues shutdown after one runtime cleanup reports an error and permits retry', async () => {
    const { manager, deployments, runtimes } = setup();
    await manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true });
    await manager.install({ artifactRoot: '/artifact-b', namespace: 'runtime.b' });
    vi.mocked(runtimes.get('build-a')!.stop).mockRejectedValueOnce(new Error('stop failed'));
    await expect(manager.shutdown()).rejects.toThrow('shutdown failed');
    expect(runtimes.get('build-b')!.stop).toHaveBeenCalledOnce();
    expect(deployments.snapshot()).toEqual([
      expect.objectContaining({ buildId: 'build-a', state: 'inactive' }),
    ]);
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(runtimes.get('build-a')!.stop).toHaveBeenCalledTimes(2);
    expect(deployments.snapshot()).toEqual([]);
  });

  it('serializes concurrent retirement and stops a runtime only once', async () => {
    const { manager, runtimes } = setup();
    const deployment = await manager.install({
      artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true,
    });

    await Promise.all([manager.retire(deployment), manager.retire(deployment)]);

    expect(runtimes.get('build-a')!.deactivate).toHaveBeenCalledOnce();
    expect(runtimes.get('build-a')!.drain).toHaveBeenCalledOnce();
    expect(runtimes.get('build-a')!.stop).toHaveBeenCalledOnce();
  });

  it('serializes duplicate concurrent installations for the same identity', async () => {
    const { manager, start } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    start.mockImplementationOnce(async () => {
      await gate;
      return managedRuntime();
    });

    const first = manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' });
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    const second = manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' });
    release();
    const results = await Promise.allSettled([first, second]);

    expect(results.map(({ status }) => status)).toEqual(['fulfilled', 'rejected']);
    expect(start).toHaveBeenCalledOnce();
  });

  it('rejects reactivation once retirement has started', async () => {
    const { manager, deployments } = setup();
    const deployment = await manager.install({
      artifactRoot: '/artifact-a', namespace: 'runtime.a', activate: true,
    });
    const lease = deployments.acquire(deployment);
    const retirement = manager.retire(deployment);

    expect(() => manager.activate(deployment)).toThrow('retiring');
    await expect(manager.deactivate(deployment)).rejects.toThrow('retiring');
    lease.release();
    await retirement;
  });

  it('waits for an installation already starting and rolls it back during shutdown', async () => {
    const artifacts = new InMemoryRscArtifactCatalog();
    const deployments = new InMemoryRscDeploymentCatalog();
    let resolveStart!: (runtime: RscManagedPluginRuntime) => void;
    const startGate = new Promise<RscManagedPluginRuntime>((resolve) => { resolveStart = resolve; });
    const runtimeValue = managedRuntime();
    const manager = new RscDeploymentManager({
      artifacts,
      deployments,
      runtime,
      verify: async () => ({ manifest: manifest('build-a'), files: [] }),
      stage,
      start: async () => startGate,
    });

    const install = manager.install({ artifactRoot: '/artifact-a', namespace: 'runtime.a' });
    await Promise.resolve();
    const shutdown = manager.shutdown();
    resolveStart(runtimeValue);

    await expect(install).rejects.toThrow('shutting down');
    await shutdown;
    expect(runtimeValue.stop).toHaveBeenCalledOnce();
    expect(artifacts.get('org.hile.fixture', 'build-a')).toBeUndefined();
    expect(deployments.snapshot()).toEqual([]);
  });
});
