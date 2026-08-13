export const HILE_RSC_DISCOVERY_SCHEMA_VERSION = 1 as const;
export const HILE_RSC_DISCOVERY_CAPABILITY = '@hile/rsc' as const;
export const HILE_RSC_DISCOVERY_TOPIC_PREFIX = '@hile/rsc/discovery/v1/' as const;
const utf8 = new TextEncoder();

export interface RscDiscoveryAnnouncement {
  schemaVersion: typeof HILE_RSC_DISCOVERY_SCHEMA_VERSION;
  capability: typeof HILE_RSC_DISCOVERY_CAPABILITY;
  instanceId: string;
  pluginId: string;
  buildId: string;
  namespace: string;
  /** Transport-neutral precedence. Higher values replace lower values for one pluginId. */
  priority: number;
  protocolVersion: 1;
  runtime: { react: string; reactDom: string; rsc: string };
  artifactOperation: string;
  authentication: { scheme: string; keyId: string; signature: string };
}

export interface RscDiscoveryDeployment {
  announcement: RscDiscoveryAnnouncement;
}

export interface RscDiscoveryManagerOptions<T extends RscDiscoveryDeployment = RscDiscoveryDeployment> {
  deploy(announcement: RscDiscoveryAnnouncement): Promise<T>;
  replace?(current: T, announcement: RscDiscoveryAnnouncement): Promise<T>;
  retire(deployment: T): Promise<void>;
  missingReconciliations?: number;
  select?: (candidates: readonly RscDiscoveryAnnouncement[]) => RscDiscoveryAnnouncement;
}

export interface RscDiscoverySnapshot {
  pluginId: string;
  buildId: string;
  namespace: string;
  instanceId: string;
  priority: number;
  state: 'enabled' | 'unavailable';
  missingReconciliations: number;
}

function requiredString(record: Record<string, unknown>, name: string): string {
  const value = record[name];
  if (typeof value !== 'string' || value.length === 0 || utf8.encode(value).byteLength > 4096) {
    throw new TypeError(`RSC discovery ${name} must not be empty or oversized`);
  }
  return value;
}

export function validateRscDiscoveryAnnouncement(value: unknown): RscDiscoveryAnnouncement {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('RSC discovery announcement must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== HILE_RSC_DISCOVERY_SCHEMA_VERSION) {
    throw new TypeError('RSC discovery schemaVersion is unsupported');
  }
  if (record.capability !== HILE_RSC_DISCOVERY_CAPABILITY) {
    throw new TypeError('RSC discovery capability is unsupported');
  }
  if (record.protocolVersion !== 1) {
    throw new TypeError('RSC discovery protocolVersion is unsupported');
  }
  if (!Number.isSafeInteger(record.priority)) {
    throw new TypeError('RSC discovery priority must be a safe integer');
  }
  const artifactOperation = requiredString(record, 'artifactOperation');
  if (!artifactOperation.startsWith('/') || artifactOperation.includes('..')) {
    throw new TypeError('RSC discovery artifactOperation must be an absolute safe operation');
  }
  const runtime = record.runtime;
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) {
    throw new TypeError('RSC discovery runtime must be an object');
  }
  const runtimeRecord = runtime as Record<string, unknown>;
  const authentication = record.authentication;
  if (authentication === null || typeof authentication !== 'object' || Array.isArray(authentication)) {
    throw new TypeError('RSC discovery authentication must be an object');
  }
  const authenticationRecord = authentication as Record<string, unknown>;
  return {
    schemaVersion: HILE_RSC_DISCOVERY_SCHEMA_VERSION,
    capability: HILE_RSC_DISCOVERY_CAPABILITY,
    instanceId: requiredString(record, 'instanceId'),
    pluginId: requiredString(record, 'pluginId'),
    buildId: requiredString(record, 'buildId'),
    namespace: requiredString(record, 'namespace'),
    priority: record.priority as number,
    protocolVersion: 1,
    runtime: {
      react: requiredString(runtimeRecord, 'react'),
      reactDom: requiredString(runtimeRecord, 'reactDom'),
      rsc: requiredString(runtimeRecord, 'rsc'),
    },
    artifactOperation,
    authentication: {
      scheme: requiredString(authenticationRecord, 'scheme'),
      keyId: requiredString(authenticationRecord, 'keyId'),
      signature: requiredString(authenticationRecord, 'signature'),
    },
  };
}

export function canonicalizeRscDiscoveryAnnouncement(
  value: Omit<RscDiscoveryAnnouncement, 'authentication'>,
): string {
  return JSON.stringify({
    schemaVersion: value.schemaVersion,
    capability: value.capability,
    instanceId: value.instanceId,
    pluginId: value.pluginId,
    buildId: value.buildId,
    namespace: value.namespace,
    priority: value.priority,
    protocolVersion: value.protocolVersion,
    runtime: value.runtime,
    artifactOperation: value.artifactOperation,
  });
}

export function createRscDiscoveryTopic(instanceId: string): string {
  if (!instanceId) throw new TypeError('RSC discovery instanceId must not be empty');
  return `${HILE_RSC_DISCOVERY_TOPIC_PREFIX}${encodeURIComponent(instanceId)}`;
}

function defaultSelect(candidates: readonly RscDiscoveryAnnouncement[]): RscDiscoveryAnnouncement {
  return [...candidates].sort((a, b) =>
    b.priority - a.priority
    || b.buildId.localeCompare(a.buildId)
    || a.namespace.localeCompare(b.namespace)
    || a.instanceId.localeCompare(b.instanceId))[0];
}

function sameDeployment(a: RscDiscoveryAnnouncement, b: RscDiscoveryAnnouncement): boolean {
  return a.pluginId === b.pluginId && a.buildId === b.buildId && a.namespace === b.namespace;
}

interface ActiveRecord<T extends RscDiscoveryDeployment> {
  deployment: T;
  missing: number;
}

export class RscDiscoveryManager<T extends RscDiscoveryDeployment = RscDiscoveryDeployment> {
  private readonly active = new Map<string, ActiveRecord<T>>();
  private readonly pendingRetirements: T[] = [];
  private readonly deploy: RscDiscoveryManagerOptions<T>['deploy'];
  private readonly retire: RscDiscoveryManagerOptions<T>['retire'];
  private readonly replace?: RscDiscoveryManagerOptions<T>['replace'];
  private readonly missingReconciliations: number;
  private readonly select: NonNullable<RscDiscoveryManagerOptions<T>['select']>;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(options: RscDiscoveryManagerOptions<T>) {
    this.deploy = options.deploy;
    this.retire = options.retire;
    this.replace = options.replace;
    this.missingReconciliations = options.missingReconciliations ?? 3;
    if (!Number.isSafeInteger(this.missingReconciliations) || this.missingReconciliations < 1) {
      throw new TypeError('missingReconciliations must be a positive safe integer');
    }
    this.select = options.select ?? defaultSelect;
  }

  public reconcile(values: readonly unknown[]): Promise<void> {
    if (this.closed) return Promise.reject(new Error('RSC discovery manager is closed'));
    const announcements = values.map(validateRscDiscoveryAnnouncement);
    const operation = async () => this.apply(announcements);
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async apply(announcements: readonly RscDiscoveryAnnouncement[]): Promise<void> {
    const errors: unknown[] = [];
    if (this.pendingRetirements.length) {
      const pending = this.pendingRetirements.splice(0);
      for (const deployment of pending) {
        try {
          await this.retire(deployment);
        } catch (error) {
          this.pendingRetirements.push(deployment);
          errors.push(error);
        }
      }
    }

    const instances = new Set<string>();
    const candidates = new Map<string, RscDiscoveryAnnouncement[]>();
    for (const announcement of announcements) {
      if (instances.has(announcement.instanceId)) {
        throw new TypeError(`Duplicate RSC discovery instanceId: ${announcement.instanceId}`);
      }
      instances.add(announcement.instanceId);
      const entries = candidates.get(announcement.pluginId) ?? [];
      entries.push(announcement);
      candidates.set(announcement.pluginId, entries);
    }

    const pluginIds = new Set([...this.active.keys(), ...candidates.keys()]);
    for (const pluginId of [...pluginIds].sort()) {
      try {
      const current = this.active.get(pluginId);
      const entries = candidates.get(pluginId);
      if (!entries?.length) {
        if (!current) continue;
        current.missing++;
        if (current.missing >= this.missingReconciliations) {
          await this.retire(current.deployment);
          this.active.delete(pluginId);
        }
        continue;
      }

      const remaining = [...entries];
      let next: T | undefined;
      const deploymentErrors: unknown[] = [];
      while (remaining.length) {
        const selected = validateRscDiscoveryAnnouncement(
          this.select(remaining.map((entry) => structuredClone(entry))),
        );
        const selectedIndex = remaining.findIndex((entry) => entry.instanceId === selected.instanceId);
        if (selected.pluginId !== pluginId || selectedIndex < 0) {
          throw new TypeError('RSC discovery selection policy returned an unknown candidate');
        }
        if (current && sameDeployment(current.deployment.announcement, selected)) {
          current.missing = 0;
          next = current.deployment;
          break;
        }
        if (
          current
          && this.replace
          && current.deployment.announcement.pluginId === selected.pluginId
          && current.deployment.announcement.buildId === selected.buildId
        ) {
          next = await this.replace(current.deployment, selected);
          break;
        }
        try {
          next = await this.deploy(selected);
          break;
        } catch (error) {
          deploymentErrors.push(error);
          remaining.splice(selectedIndex, 1);
        }
      }
      if (!next) {
        throw new AggregateError(deploymentErrors, `No deployable RSC discovery candidate: ${pluginId}`);
      }
      if (current && next === current.deployment) continue;
      this.active.set(pluginId, { deployment: next, missing: 0 });
      if (current && current.deployment.announcement.buildId !== next.announcement.buildId) {
        try {
          await this.retire(current.deployment);
        } catch (error) {
          this.pendingRetirements.push(current.deployment);
          throw error;
        }
      }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) {
      const detail = errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ');
      throw new AggregateError(errors, `RSC discovery reconciliation failed: ${detail}`);
    }
  }

  public snapshot(): RscDiscoverySnapshot[] {
    return [...this.active.values()]
      .map(({ deployment, missing }) => ({
        pluginId: deployment.announcement.pluginId,
        buildId: deployment.announcement.buildId,
        namespace: deployment.announcement.namespace,
        instanceId: deployment.announcement.instanceId,
        priority: deployment.announcement.priority,
        state: missing > 0 ? 'unavailable' as const : 'enabled' as const,
        missingReconciliations: missing,
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
  }

  public async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const operation = (async () => {
      await this.queue;
      const deployments = new Set<T>([
        ...this.pendingRetirements,
        ...[...this.active.values()].reverse().map(({ deployment }) => deployment),
      ]);
      const errors: unknown[] = [];
      for (const deployment of deployments) {
        try {
          await this.retire(deployment);
          const pendingIndex = this.pendingRetirements.indexOf(deployment);
          if (pendingIndex >= 0) this.pendingRetirements.splice(pendingIndex, 1);
          const active = this.active.get(deployment.announcement.pluginId);
          if (active?.deployment === deployment) this.active.delete(deployment.announcement.pluginId);
        } catch (error) {
          if (!this.pendingRetirements.includes(deployment)) this.pendingRetirements.push(deployment);
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'RSC discovery shutdown failed');
    })();
    this.closePromise = operation.catch((error) => {
      this.closePromise = undefined;
      throw error;
    });
    return this.closePromise;
  }
}
