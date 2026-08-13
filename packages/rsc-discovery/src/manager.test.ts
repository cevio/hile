import { describe, expect, it, vi } from 'vitest';
import {
  RscDiscoveryManager,
  validateRscDiscoveryAnnouncement,
  type RscDiscoveryAnnouncement,
  type RscDiscoveryDeployment,
} from './index';

function announcement(overrides: Partial<RscDiscoveryAnnouncement> = {}): RscDiscoveryAnnouncement {
  return {
    schemaVersion: 1,
    capability: '@hile/rsc',
    instanceId: 'instance-v1',
    pluginId: 'org.hile.fixture',
    buildId: 'build-v1',
    namespace: 'fixture.v1',
    priority: 1,
    protocolVersion: 1,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    artifactOperation: '/-/rsc/artifact',
    authentication: { scheme: 'test', keyId: 'fixture', signature: 'valid' },
    ...overrides,
  };
}

function setup(missingReconciliations = 2) {
  const deployed: RscDiscoveryDeployment[] = [];
  const retired: RscDiscoveryDeployment[] = [];
  const deploy = vi.fn(async (candidate: RscDiscoveryAnnouncement) => {
    const value = { announcement: structuredClone(candidate) };
    deployed.push(value);
    return value;
  });
  const retire = vi.fn(async (deployment: RscDiscoveryDeployment) => {
    retired.push(deployment);
  });
  const manager = new RscDiscoveryManager({ deploy, retire, missingReconciliations });
  return { manager, deploy, retire, deployed, retired };
}

describe('RscDiscoveryManager', () => {
  it('automatically deploys the first healthy Registry announcement', async () => {
    const { manager, deploy } = setup();
    await manager.reconcile([announcement()]);
    expect(deploy).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ pluginId: 'org.hile.fixture', buildId: 'build-v1', state: 'enabled' }),
    ]);
  });

  it('selects the highest priority build and atomically retires the previous build', async () => {
    const { manager, deploy, retire } = setup();
    const v1 = announcement();
    const v2 = announcement({ instanceId: 'instance-v2', buildId: 'build-v2', namespace: 'fixture.v2', priority: 2 });
    await manager.reconcile([v1]);
    await manager.reconcile([v1, v2]);
    expect(deploy.mock.calls.map(([candidate]) => candidate.buildId)).toEqual(['build-v1', 'build-v2']);
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ announcement: expect.objectContaining({ buildId: 'build-v1' }) }));
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ buildId: 'build-v2', state: 'enabled' }),
    ]);
  });

  it('keeps the working build enabled when a replacement cannot be deployed', async () => {
    const { manager, deploy, retire } = setup();
    const v1 = announcement();
    const v2 = announcement({ instanceId: 'instance-v2', buildId: 'build-v2', namespace: 'fixture.v2', priority: 2 });
    await manager.reconcile([v1]);
    deploy.mockRejectedValueOnce(new Error('artifact integrity mismatch'));
    await expect(manager.reconcile([v1, v2])).resolves.toBeUndefined();
    expect(retire).not.toHaveBeenCalled();
    expect(manager.snapshot()[0]).toMatchObject({ buildId: 'build-v1', state: 'enabled' });
  });

  it('retries cleanup after a replacement activates but retiring the previous build fails', async () => {
    const { manager, retire } = setup();
    const v1 = announcement();
    const v2 = announcement({ instanceId: 'instance-v2', buildId: 'build-v2', namespace: 'fixture.v2', priority: 2 });
    await manager.reconcile([v1]);
    retire.mockRejectedValueOnce(new Error('temporary drain failure'));

    await expect(manager.reconcile([v1, v2])).rejects.toThrow('temporary drain failure');
    expect(manager.snapshot()[0]).toMatchObject({ buildId: 'build-v2', state: 'enabled' });

    await manager.reconcile([v1, v2]);
    expect(retire).toHaveBeenCalledTimes(2);
    await manager.close();
    expect(retire).toHaveBeenCalledTimes(3);
  });

  it('falls back to a remaining lower-priority service after the selected service unregisters', async () => {
    const { manager, deploy, retire } = setup(1);
    const v1 = announcement();
    const v2 = announcement({ instanceId: 'instance-v2', buildId: 'build-v2', namespace: 'fixture.v2', priority: 2 });
    await manager.reconcile([v1, v2]);
    await manager.reconcile([v1]);
    expect(deploy.mock.calls.map(([candidate]) => candidate.buildId)).toEqual(['build-v2', 'build-v1']);
    expect(retire).toHaveBeenCalledWith(expect.objectContaining({ announcement: expect.objectContaining({ buildId: 'build-v2' }) }));
    expect(manager.snapshot()[0]).toMatchObject({ buildId: 'build-v1', state: 'enabled' });
  });

  it('falls back to a healthy lower-priority candidate when the preferred candidate cannot deploy', async () => {
    const { manager, deploy } = setup();
    const healthy = announcement({ instanceId: 'healthy', priority: 1 });
    const broken = announcement({ instanceId: 'broken', buildId: 'broken', namespace: 'broken', priority: 2 });
    deploy.mockImplementation(async (candidate) => {
      if (candidate.instanceId === 'broken') throw new Error('corrupt');
      return { announcement: structuredClone(candidate) };
    });
    await manager.reconcile([healthy, broken]);
    expect(manager.snapshot()[0]).toMatchObject({ instanceId: 'healthy', state: 'enabled' });
  });

  it('rebinds an equivalent build to a surviving replica namespace without redeploying artifacts', async () => {
    const deployed: RscDiscoveryDeployment[] = [];
    const deploy = vi.fn(async (candidate: RscDiscoveryAnnouncement) => {
      const value = { announcement: structuredClone(candidate) };
      deployed.push(value);
      return value;
    });
    const replace = vi.fn(async (_current: RscDiscoveryDeployment, candidate: RscDiscoveryAnnouncement) =>
      ({ announcement: structuredClone(candidate) }));
    const retire = vi.fn(async () => undefined);
    const manager = new RscDiscoveryManager({ deploy, replace, retire, missingReconciliations: 1 });
    const first = announcement({ instanceId: 'replica-a', namespace: 'fixture.a' });
    const second = announcement({ instanceId: 'replica-b', namespace: 'fixture.b' });
    await manager.reconcile([first]);
    await manager.reconcile([second]);
    expect(deploy).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledOnce();
    expect(retire).not.toHaveBeenCalled();
    expect(manager.snapshot()[0]).toMatchObject({ namespace: 'fixture.b' });
  });

  it('uses a grace window before retiring a plugin missing from Registry snapshots', async () => {
    const { manager, retire } = setup(2);
    await manager.reconcile([announcement()]);
    await manager.reconcile([]);
    expect(retire).not.toHaveBeenCalled();
    expect(manager.snapshot()[0]).toMatchObject({ state: 'unavailable', missingReconciliations: 1 });
    await manager.reconcile([]);
    expect(retire).toHaveBeenCalledOnce();
    expect(manager.snapshot()).toEqual([]);
  });

  it('does not redeploy equivalent replicas or duplicate snapshots', async () => {
    const { manager, deploy } = setup();
    const first = announcement();
    const replica = announcement({ instanceId: 'instance-v1-replica' });
    await manager.reconcile([first, replica]);
    await manager.reconcile([replica, first]);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('serializes overlapping reconcile calls', async () => {
    const { manager, deploy } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    deploy.mockImplementationOnce(async (candidate) => {
      await gate;
      return { announcement: structuredClone(candidate) };
    });
    const first = manager.reconcile([announcement()]);
    const second = manager.reconcile([announcement()]);
    release();
    await Promise.all([first, second]);
    expect(deploy).toHaveBeenCalledOnce();
  });

  it('isolates one plugin failure so other plugin ids still reconcile', async () => {
    const { manager, deploy } = setup();
    deploy.mockImplementation(async (candidate) => {
      if (candidate.pluginId === 'aaa.bad') throw new Error('bad artifact');
      return { announcement: structuredClone(candidate) };
    });
    await expect(manager.reconcile([
      announcement({ pluginId: 'aaa.bad', instanceId: 'bad' }),
      announcement({ pluginId: 'zzz.good', instanceId: 'good' }),
    ])).rejects.toThrow('reconciliation failed');
    expect(manager.snapshot()).toEqual([
      expect.objectContaining({ pluginId: 'zzz.good', state: 'enabled' }),
    ]);
  });

  it('closes idempotently and rejects reconciliation after close', async () => {
    const { manager, retire } = setup();
    await manager.reconcile([announcement()]);
    await manager.close();
    await manager.close();
    expect(retire).toHaveBeenCalledOnce();
    await expect(manager.reconcile([announcement()])).rejects.toThrow('closed');
  });

  it('retains failed retirements so close can be retried', async () => {
    const { manager, retire } = setup();
    await manager.reconcile([announcement()]);
    retire.mockRejectedValueOnce(new Error('temporary stop failure'));

    await expect(manager.close()).rejects.toThrow('RSC discovery shutdown failed');
    await manager.close();

    expect(retire).toHaveBeenCalledTimes(2);
    expect(manager.snapshot()).toEqual([]);
    await expect(manager.reconcile([])).rejects.toThrow('closed');
  });

  it('validates discovery data at the trust boundary', () => {
    expect(() => validateRscDiscoveryAnnouncement({ ...announcement(), priority: Number.NaN }))
      .toThrow('priority');
    expect(() => validateRscDiscoveryAnnouncement({ ...announcement(), artifactOperation: '../secret' }))
      .toThrow('artifactOperation');
    expect(() => validateRscDiscoveryAnnouncement({ ...announcement(), capability: 'other' }))
      .toThrow('capability');
  });
});
