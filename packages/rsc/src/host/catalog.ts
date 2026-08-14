import type {
  RscCallOptions,
  RscPluginClient,
  RscPluginLease,
  RscPluginLocator,
} from '../transport';

export type RscDeploymentState = 'active' | 'draining' | 'inactive';

export interface RscPluginDeployment {
  pluginId: string;
  buildId: string;
  namespace: string;
}

export interface RscDeploymentSnapshot extends RscPluginDeployment {
  state: RscDeploymentState;
  references: number;
}

export type RscDeploymentCatalogErrorCode =
  | 'ERR_RSC_DEPLOYMENT_ALREADY_INSTALLED'
  | 'ERR_RSC_DEPLOYMENT_NOT_INSTALLED'
  | 'ERR_RSC_DEPLOYMENT_INACTIVE'
  | 'ERR_RSC_DEPLOYMENT_REFERENCED';

export class RscDeploymentCatalogError extends Error {
  constructor(
    public readonly code: RscDeploymentCatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RscDeploymentCatalogError';
  }
}

interface DeploymentRecord {
  deployment: RscPluginDeployment;
  state: RscDeploymentState;
  references: number;
  drainWaiters: Set<() => void>;
}

function key(target: { pluginId: string; buildId: string }): string {
  return `${target.pluginId}\0${target.buildId}`;
}

function cloneDeployment(deployment: RscPluginDeployment): RscPluginDeployment {
  return {
    pluginId: deployment.pluginId,
    buildId: deployment.buildId,
    namespace: deployment.namespace,
  };
}

function assertDeployment(deployment: RscPluginDeployment): void {
  for (const [name, value] of Object.entries(deployment)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`RSC deployment ${name} must not be empty`);
    }
  }
}

export class InMemoryRscDeploymentCatalog {
  private readonly records = new Map<string, DeploymentRecord>();
  private readonly activeBuilds = new Map<string, string>();

  public install(
    deployment: RscPluginDeployment,
    options: { activate?: boolean } = {},
  ): () => boolean {
    assertDeployment(deployment);
    const deploymentKey = key(deployment);
    if (this.records.has(deploymentKey)) {
      throw new RscDeploymentCatalogError(
        'ERR_RSC_DEPLOYMENT_ALREADY_INSTALLED',
        `RSC deployment is already installed: ${deployment.pluginId}@${deployment.buildId}`,
      );
    }
    this.records.set(deploymentKey, {
      deployment: cloneDeployment(deployment),
      state: 'inactive',
      references: 0,
      drainWaiters: new Set(),
    });
    if (options.activate) this.activate(deployment);
    return () => this.remove(deployment);
  }

  private required(target: { pluginId: string; buildId: string }): DeploymentRecord {
    const record = this.records.get(key(target));
    if (!record) {
      throw new RscDeploymentCatalogError(
        'ERR_RSC_DEPLOYMENT_NOT_INSTALLED',
        `RSC deployment is not installed: ${target.pluginId}@${target.buildId}`,
      );
    }
    return record;
  }

  public activate(target: { pluginId: string; buildId: string }): void {
    const next = this.required(target);
    const currentBuild = this.activeBuilds.get(target.pluginId);
    if (currentBuild && currentBuild !== target.buildId) {
      this.required({ pluginId: target.pluginId, buildId: currentBuild }).state = 'draining';
    }
    next.state = 'active';
    this.activeBuilds.set(target.pluginId, target.buildId);
  }

  public rebind(
    target: { pluginId: string; buildId: string },
    namespace: string,
  ): RscPluginDeployment {
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new TypeError('RSC deployment namespace must not be empty');
    }
    const record = this.required(target);
    record.deployment = { ...record.deployment, namespace };
    return cloneDeployment(record.deployment);
  }

  public deactivate(target: { pluginId: string; buildId: string }): void {
    const record = this.required(target);
    record.state = 'inactive';
    if (this.activeBuilds.get(target.pluginId) === target.buildId) {
      this.activeBuilds.delete(target.pluginId);
    }
  }

  public getActive(pluginId: string): RscPluginDeployment | undefined {
    const buildId = this.activeBuilds.get(pluginId);
    if (!buildId) return undefined;
    return cloneDeployment(this.required({ pluginId, buildId }).deployment);
  }

  public acquire(target: { pluginId: string; buildId: string }): {
    deployment: RscPluginDeployment;
    release(): void;
  } {
    const record = this.required(target);
    if (record.state !== 'active') {
      throw new RscDeploymentCatalogError(
        'ERR_RSC_DEPLOYMENT_INACTIVE',
        `RSC deployment is not active: ${target.pluginId}@${target.buildId}`,
      );
    }
    record.references++;
    let released = false;
    return {
      deployment: cloneDeployment(record.deployment),
      release: () => {
        if (released) return;
        released = true;
        record.references--;
        if (record.references === 0) {
          for (const resolve of record.drainWaiters) resolve();
          record.drainWaiters.clear();
        }
      },
    };
  }

  public async drain(target: { pluginId: string; buildId: string }): Promise<void> {
    const record = this.required(target);
    if (record.references === 0) return;
    await new Promise<void>((resolve) => record.drainWaiters.add(resolve));
  }

  public remove(target: { pluginId: string; buildId: string }): boolean {
    const deploymentKey = key(target);
    const record = this.records.get(deploymentKey);
    if (!record) return false;
    if (record.references > 0) {
      throw new RscDeploymentCatalogError(
        'ERR_RSC_DEPLOYMENT_REFERENCED',
        `RSC deployment is still referenced: ${target.pluginId}@${target.buildId}`,
      );
    }
    if (this.activeBuilds.get(target.pluginId) === target.buildId) {
      this.activeBuilds.delete(target.pluginId);
    }
    this.records.delete(deploymentKey);
    return true;
  }

  public snapshot(): RscDeploymentSnapshot[] {
    return [...this.records.values()].map(({ deployment, state, references }) => ({
      ...cloneDeployment(deployment),
      state,
      references,
    }));
  }
}

export interface RscDeploymentSnapshotSource {
  snapshot(options?: RscCallOptions): Promise<RscDeploymentSnapshot[]>;
}

function validateSnapshot(value: unknown): RscDeploymentSnapshot[] {
  if (!Array.isArray(value)) throw new TypeError('RSC deployment snapshot must be an array');
  const active = new Set<string>();
  const identities = new Set<string>();
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new TypeError(`RSC deployment snapshot[${index}] must be an object`);
    }
    const snapshot = item as Partial<RscDeploymentSnapshot>;
    const deployment = {
      pluginId: snapshot.pluginId!, buildId: snapshot.buildId!, namespace: snapshot.namespace!,
    };
    assertDeployment(deployment);
    if (!['active', 'draining', 'inactive'].includes(snapshot.state!)) {
      throw new TypeError(`RSC deployment snapshot[${index}] has an invalid state`);
    }
    if (!Number.isSafeInteger(snapshot.references) || snapshot.references! < 0) {
      throw new TypeError(`RSC deployment snapshot[${index}] has invalid references`);
    }
    const identity = key(deployment);
    if (identities.has(identity)) throw new TypeError(`RSC deployment snapshot has duplicate identity: ${identity}`);
    identities.add(identity);
    if (snapshot.state === 'active') {
      if (active.has(deployment.pluginId)) {
        throw new TypeError(`RSC deployment snapshot has multiple active builds: ${deployment.pluginId}`);
      }
      active.add(deployment.pluginId);
    }
    return { ...deployment, state: snapshot.state, references: snapshot.references } as RscDeploymentSnapshot;
  });
}

export class RscDeploymentSnapshotCache {
  private current: RscDeploymentSnapshot[] = [];

  public update(value: unknown): void {
    const next = validateSnapshot(value);
    this.current = next;
  }

  public async refresh(source: RscDeploymentSnapshotSource, options?: RscCallOptions): Promise<void> {
    const next = await source.snapshot(options);
    this.update(next);
  }

  public snapshot(): RscDeploymentSnapshot[] {
    return structuredClone(this.current);
  }

  public getActive(pluginId: string): RscPluginDeployment | undefined {
    const active = this.current.find((entry) => entry.pluginId === pluginId && entry.state === 'active');
    return active ? cloneDeployment(active) : undefined;
  }
}

export type RscPluginConnector = (
  deployment: RscPluginDeployment,
  options?: RscCallOptions,
) => Promise<RscPluginClient>;

export function createCatalogRscPluginLocator(
  catalog: InMemoryRscDeploymentCatalog,
  connect: RscPluginConnector,
): RscPluginLocator {
  return {
    async resolve(target, options): Promise<RscPluginLease> {
      const catalogLease = catalog.acquire(target);
      try {
        const client = await connect(catalogLease.deployment, options);
        return {
          client,
          release: catalogLease.release,
        };
      } catch (error) {
        catalogLease.release();
        throw error;
      }
    },
  };
}
