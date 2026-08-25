import { describe, expect, it, vi } from 'vitest';
import { createExecutionContext, MissingExecutionContextError } from '@hile/context';
import { Server } from '@hile/micro';
import {
  InMemoryRscDeploymentCatalog,
  RscDeploymentSnapshotCache,
} from './catalog';
import {
  attachRscDeploymentCatalog,
  createHileRscDeploymentCatalogClient,
} from '../transport/catalog';

const deployment = {
  pluginId: 'org.hile.fixture', buildId: 'build-a', namespace: 'runtime.fixture.a',
};
const callOptions = {
  context: createExecutionContext({ requestId: 'rsc-catalog-service-test' }),
  signal: new AbortController().signal,
};

describe('internal deployment catalog service', () => {
  it('attaches lifecycle operations to a generic internal registrar without a listener', async () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    const server = new Server('com.hile.rsc.catalog', { advertiseHost: '127.0.0.1' });
    const detach = attachRscDeploymentCatalog(catalog, server);

    expect(server.port).toBeUndefined();
    await server.dispatch('/-/rsc/catalog/install', { deployment, activate: true });
    await expect(server.dispatch('/-/rsc/catalog/active', { pluginId: deployment.pluginId }))
      .resolves.toEqual(deployment);
    await expect(server.dispatch('/-/rsc/catalog/snapshot', {})).resolves.toEqual([
      { ...deployment, state: 'active', references: 0 },
    ]);
    await server.dispatch('/-/rsc/catalog/deactivate', deployment);
    await expect(server.dispatch('/-/rsc/catalog/active', { pluginId: deployment.pluginId }))
      .resolves.toBeUndefined();

    detach();
    await expect(server.dispatch('/-/rsc/catalog/snapshot', {}))
      .rejects.toMatchObject({ status: 'NOT_FOUND' });
  });

  it('uses configurable operation names through an application-like transport', async () => {
    const application = { call: vi.fn(async () => [{ ...deployment, state: 'active', references: 0 }]) };
    const client = createHileRscDeploymentCatalogClient(application, 'catalog.runtime', {
      snapshot: 'catalog.read', active: 'catalog.active', install: 'catalog.install',
      activate: 'catalog.activate', deactivate: 'catalog.deactivate', remove: 'catalog.remove',
    });
    await expect(client.snapshot(callOptions)).resolves.toHaveLength(1);
    expect(application.call).toHaveBeenCalledWith('catalog.runtime', 'catalog.read', {}, callOptions);
  });

  it('rolls back partial catalog registration when an operation conflicts', () => {
    const handlers = new Map<string, unknown>();
    const registrar = {
      register(operation: string, handler: unknown) {
        if (operation.endsWith('/install')) throw new Error('operation conflict');
        handlers.set(operation, handler);
        return () => { handlers.delete(operation); };
      },
    };

    expect(() => attachRscDeploymentCatalog(new InMemoryRscDeploymentCatalog(), registrar))
      .toThrow('operation conflict');
    expect(handlers.size).toBe(0);
  });
});

describe('RscDeploymentSnapshotCache', () => {
  it('rejects missing context before reading the snapshot source', async () => {
    const cache = new RscDeploymentSnapshotCache();
    const source = { snapshot: vi.fn() };

    await expect((cache.refresh as any)(source))
      .rejects.toBeInstanceOf(MissingExecutionContextError);
    expect(source.snapshot).not.toHaveBeenCalled();
  });

  it('publishes defensive valid snapshots and resolves the active build', () => {
    const cache = new RscDeploymentSnapshotCache();
    cache.update([{ ...deployment, state: 'active', references: 0 }]);
    const snapshot = cache.snapshot();
    snapshot[0].namespace = 'mutated';
    expect(cache.getActive(deployment.pluginId)).toEqual(deployment);
    expect(cache.snapshot()[0].namespace).toBe(deployment.namespace);
  });

  it('retains the last valid snapshot during source failure or invalid refresh', async () => {
    const cache = new RscDeploymentSnapshotCache();
    cache.update([{ ...deployment, state: 'active', references: 0 }]);
    await expect(cache.refresh({ snapshot: async () => { throw new Error('catalog offline'); } }, callOptions))
      .rejects.toThrow('catalog offline');
    expect(cache.getActive(deployment.pluginId)).toEqual(deployment);

    await expect(cache.refresh({ snapshot: async () => [{ ...deployment, state: 'broken' as any, references: 0 }] }, callOptions))
      .rejects.toThrow('state');
    expect(cache.getActive(deployment.pluginId)).toEqual(deployment);
  });

  it('rejects duplicate active builds and malformed identities atomically', () => {
    const cache = new RscDeploymentSnapshotCache();
    expect(() => cache.update([
      { ...deployment, state: 'active', references: 0 },
      { ...deployment, buildId: 'build-b', state: 'active', references: 0 },
    ])).toThrow('multiple active');
    expect(cache.snapshot()).toEqual([]);
  });
});
