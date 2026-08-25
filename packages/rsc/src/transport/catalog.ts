import type {
  InMemoryRscDeploymentCatalog,
  RscDeploymentSnapshot,
  RscPluginDeployment,
} from '../host/catalog';
import { requireRscCallOptions, type RscCallOptions } from './contracts';
import { registerRscOperations, type RscOperationRegistrar } from './registrar';

export interface RscCatalogOperationMap {
  snapshot: string;
  active: string;
  install: string;
  activate: string;
  deactivate: string;
  remove: string;
}

export const DEFAULT_RSC_CATALOG_OPERATIONS: Readonly<RscCatalogOperationMap> = Object.freeze({
  snapshot: '/-/rsc/catalog/snapshot',
  active: '/-/rsc/catalog/active',
  install: '/-/rsc/catalog/install',
  activate: '/-/rsc/catalog/activate',
  deactivate: '/-/rsc/catalog/deactivate',
  remove: '/-/rsc/catalog/remove',
});

export function attachRscDeploymentCatalog(
  catalog: InMemoryRscDeploymentCatalog,
  registrar: RscOperationRegistrar,
  operations: RscCatalogOperationMap = DEFAULT_RSC_CATALOG_OPERATIONS,
): () => void {
  return registerRscOperations(registrar, [
    [operations.snapshot, () => catalog.snapshot()],
    [operations.active, ({ data }) => {
      const pluginId = (data as { pluginId?: unknown })?.pluginId;
      if (typeof pluginId !== 'string' || !pluginId) throw new TypeError('pluginId must not be empty');
      return catalog.getActive(pluginId);
    }],
    [operations.install, ({ data }) => {
      const value = data as { deployment?: RscPluginDeployment; activate?: boolean };
      if (!value?.deployment || typeof value.deployment !== 'object') {
        throw new TypeError('deployment must be an object');
      }
      catalog.install(value.deployment, { activate: value.activate === true });
      return true;
    }],
    [operations.activate, ({ data }) => {
      catalog.activate(data as RscPluginDeployment);
      return true;
    }],
    [operations.deactivate, ({ data }) => {
      catalog.deactivate(data as RscPluginDeployment);
      return true;
    }],
    [operations.remove, ({ data }) => catalog.remove(data as RscPluginDeployment)],
  ]);
}

export interface HileRscCatalogApplication {
  call<T>(
    namespace: string,
    operation: string,
    data: unknown,
    options: RscCallOptions,
  ): Promise<T>;
}

export interface RscDeploymentCatalogClient {
  snapshot(options: RscCallOptions): Promise<RscDeploymentSnapshot[]>;
  getActive(pluginId: string, options: RscCallOptions): Promise<RscPluginDeployment | undefined>;
  install(deployment: RscPluginDeployment, activate: boolean, options: RscCallOptions): Promise<boolean>;
  activate(deployment: RscPluginDeployment, options: RscCallOptions): Promise<boolean>;
  deactivate(deployment: RscPluginDeployment, options: RscCallOptions): Promise<boolean>;
  remove(deployment: RscPluginDeployment, options: RscCallOptions): Promise<boolean>;
}

export function createHileRscDeploymentCatalogClient(
  application: HileRscCatalogApplication,
  namespace = 'com.hile.rsc.catalog',
  operations: RscCatalogOperationMap = DEFAULT_RSC_CATALOG_OPERATIONS,
): RscDeploymentCatalogClient {
  return {
    snapshot: (options) => application.call(
      namespace, operations.snapshot, {}, requireRscCallOptions(options, 'RSC catalog snapshot'),
    ),
    getActive: (pluginId, options) => application.call(
      namespace, operations.active, { pluginId }, requireRscCallOptions(options, 'RSC catalog active lookup'),
    ),
    install: (deployment, activate, options) =>
      application.call(
        namespace, operations.install, { deployment, activate }, requireRscCallOptions(options, 'RSC catalog install'),
      ),
    activate: (deployment, options) => application.call(
      namespace, operations.activate, deployment, requireRscCallOptions(options, 'RSC catalog activate'),
    ),
    deactivate: (deployment, options) => application.call(
      namespace, operations.deactivate, deployment, requireRscCallOptions(options, 'RSC catalog deactivate'),
    ),
    remove: (deployment, options) => application.call(
      namespace, operations.remove, deployment, requireRscCallOptions(options, 'RSC catalog remove'),
    ),
  };
}
