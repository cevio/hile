import type { RscPluginDeployment } from '@hile/rsc/host/catalog';
import { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import type { DemoDeploymentDefinition } from './demo-inventory';

export type DemoLifecycleOperation = 'install' | 'activate' | 'deactivate' | 'remove';
export type DemoLifecycleMode = 'production' | 'development';

function key(target: { pluginId: string; buildId: string }): string {
  return `${target.pluginId}\0${target.buildId}`;
}

export class DemoDeploymentController {
  private readonly inventory: ReadonlyMap<string, DemoDeploymentDefinition>;

  constructor(
    private readonly catalog: InMemoryRscDeploymentCatalog,
    definitions: readonly DemoDeploymentDefinition[],
    options: { mode?: DemoLifecycleMode } = {},
  ) {
    this.inventory = new Map(definitions.map((definition) => [key(definition), definition]));
    this.mode = options.mode ?? 'production';
  }

  public readonly mode: DemoLifecycleMode;

  private definition(target: { pluginId: string; buildId: string }): DemoDeploymentDefinition {
    const definition = this.inventory.get(key(target));
    if (!definition) {
      throw new TypeError(`Unknown demo deployment: ${target.pluginId}@${target.buildId}`);
    }
    return definition;
  }

  private deployment(target: { pluginId: string; buildId: string }): RscPluginDeployment {
    const definition = this.definition(target);
    return {
      pluginId: definition.pluginId,
      buildId: definition.buildId,
      namespace: definition.namespace,
    };
  }

  private developmentDeployment(target: { pluginId: string; buildId: string }): RscPluginDeployment {
    const definition = this.definition(target);
    const matches = this.catalog.snapshot().filter((entry) =>
      entry.pluginId === definition.pluginId && entry.namespace === definition.namespace);
    const match = matches.find(({ state }) => state === 'active') ?? matches.at(-1);
    if (!match) throw new Error(`Development revision is not available: ${target.pluginId}@${target.buildId}`);
    return { pluginId: match.pluginId, buildId: match.buildId, namespace: match.namespace };
  }

  public initialize(): void {
    if (this.mode === 'development') return;
    for (const definition of this.inventory.values()) {
      if (!definition.initial) continue;
      this.catalog.install(this.deployment(definition), { activate: true });
    }
  }

  public apply(
    operation: DemoLifecycleOperation,
    target: { pluginId: string; buildId: string },
  ) {
    const deployment = this.mode === 'development'
      ? this.developmentDeployment(target)
      : this.deployment(target);
    if (operation === 'install') {
      const exists = this.catalog.snapshot().some(({ pluginId, buildId }) =>
        pluginId === deployment.pluginId && buildId === deployment.buildId);
      if (!exists) this.catalog.install(deployment);
    } else if (operation === 'activate') {
      this.catalog.activate(deployment);
    } else if (operation === 'deactivate') {
      this.catalog.deactivate(deployment);
    } else if (operation === 'remove') {
      this.catalog.remove(deployment);
    } else {
      throw new TypeError(`Unsupported demo lifecycle operation: ${String(operation)}`);
    }
    return this.catalog.snapshot();
  }
}
