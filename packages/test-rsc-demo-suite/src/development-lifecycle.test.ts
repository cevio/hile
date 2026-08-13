import { describe, expect, it } from 'vitest';
import { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import { DemoDeploymentController } from '../../test-rsc-host/src/services/demo-deployment-controller';

const inventory = [{
  pluginId: 'demo.rsc.capabilities',
  buildId: 'v1',
  namespace: 'demo.rsc.capabilities.v1',
  artifactRoot: '/unused',
  initial: true,
}] as const;

describe('demo deployment lifecycle modes', () => {
  it('maps stable lifecycle build ids to the latest development build in the same namespace', () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    const lifecycle = new DemoDeploymentController(catalog, inventory, { mode: 'development' });

    lifecycle.initialize();
    expect(catalog.snapshot()).toEqual([]);
    catalog.install({
      pluginId: 'demo.rsc.capabilities',
      buildId: 'v1-dev-session-r2',
      namespace: 'demo.rsc.capabilities.v1',
    });

    expect(lifecycle.apply('install', { pluginId: 'demo.rsc.capabilities', buildId: 'v1' }))
      .toEqual([expect.objectContaining({ buildId: 'v1-dev-session-r2', state: 'inactive' })]);
    expect(lifecycle.apply('activate', { pluginId: 'demo.rsc.capabilities', buildId: 'v1' }))
      .toEqual([expect.objectContaining({ buildId: 'v1-dev-session-r2', state: 'active' })]);
    expect(lifecycle.apply('deactivate', { pluginId: 'demo.rsc.capabilities', buildId: 'v1' }))
      .toEqual([expect.objectContaining({ buildId: 'v1-dev-session-r2', state: 'inactive' })]);
    expect(lifecycle.apply('remove', { pluginId: 'demo.rsc.capabilities', buildId: 'v1' }))
      .toEqual([]);
  });

  it('retains static install and activation controls in production mode', () => {
    const catalog = new InMemoryRscDeploymentCatalog();
    const lifecycle = new DemoDeploymentController(catalog, inventory, { mode: 'production' });

    lifecycle.initialize();

    expect(catalog.snapshot()).toEqual([
      expect.objectContaining({ buildId: 'v1', state: 'active' }),
    ]);
  });
});
