import { describe, expect, it, vi } from 'vitest';
import type { RscPluginClient } from '../transport';
import {
  InMemoryRscDeploymentCatalog,
  RscDeploymentCatalogError,
  createCatalogRscPluginLocator,
} from './catalog';

const deploymentA = {
  pluginId: 'org.hile.fixture',
  buildId: 'build-a',
  namespace: 'runtime.fixture.a',
};
const deploymentB = {
  pluginId: 'org.hile.fixture',
  buildId: 'build-b',
  namespace: 'runtime.fixture.b',
};

describe('InMemoryRscDeploymentCatalog', () => {
  it('activates a deployment and resolves a defensive active snapshot', () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    const active = catalog.getActive(deploymentA.pluginId)!;
    active.namespace = 'mutated';

    expect(catalog.getActive(deploymentA.pluginId)).toEqual(deploymentA);
    expect(catalog.snapshot()).toEqual([{ ...deploymentA, state: 'active', references: 0 }]);
  });

  it('switches new acquisitions to a new build while an old lease drains', async () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    const oldLease = catalog.acquire({ pluginId: deploymentA.pluginId, buildId: deploymentA.buildId });

    catalog.install(deploymentB, { activate: true });
    expect(catalog.getActive(deploymentA.pluginId)).toEqual(deploymentB);
    expect(catalog.snapshot()).toEqual([
      { ...deploymentA, state: 'draining', references: 1 },
      { ...deploymentB, state: 'active', references: 0 },
    ]);
    expect(() => catalog.acquire(deploymentA)).toThrow('not active');

    let drained = false;
    const drain = catalog.drain(deploymentA).then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    oldLease.release();
    oldLease.release();
    await drain;
    expect(drained).toBe(true);
  });

  it('deactivates a build, rejects new leases and permits removal after drain', async () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    catalog.deactivate(deploymentA);

    expect(catalog.getActive(deploymentA.pluginId)).toBeUndefined();
    expect(() => catalog.acquire(deploymentA)).toThrow(RscDeploymentCatalogError);
    await catalog.drain(deploymentA);
    expect(catalog.remove(deploymentA)).toBe(true);
    expect(catalog.remove(deploymentA)).toBe(false);
  });

  it('rejects duplicate, unknown and identity-conflicting lifecycle operations', () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA);
    expect(() => catalog.install(deploymentA)).toThrow('already installed');
    expect(() => catalog.activate({ pluginId: deploymentA.pluginId, buildId: 'missing' }))
      .toThrow('not installed');
    expect(() => catalog.acquire({ pluginId: 'missing', buildId: 'missing' })).toThrow('not installed');
  });

  it('refuses to remove a referenced deployment', () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    catalog.acquire(deploymentA);
    expect(() => catalog.remove(deploymentA)).toThrow('still referenced');
  });
});

describe('catalog-backed plugin locator', () => {
  it('composes catalog leases with an injected connection factory', async () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    const client = {} as RscPluginClient;
    const connect = vi.fn(async () => client);
    const locator = createCatalogRscPluginLocator(catalog, connect);
    const signal = new AbortController().signal;

    const lease = await locator.resolve(deploymentA, { signal });
    expect(lease.client).toBe(client);
    expect(lease.verificationKey).toBeUndefined();
    expect(connect).toHaveBeenCalledWith(deploymentA, { signal });
    expect(catalog.snapshot()[0].references).toBe(1);
    lease.release();
    expect(catalog.snapshot()[0].references).toBe(0);
  });

  it('releases the catalog lease when connection creation fails', async () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    catalog.install(deploymentA, { activate: true });
    const locator = createCatalogRscPluginLocator(catalog, async () => {
      throw new Error('connection failed');
    });

    await expect(locator.resolve(deploymentA)).rejects.toThrow('connection failed');
    expect(catalog.snapshot()[0].references).toBe(0);
  });
});
