import type { Application } from '@hile/micro';
import type { InMemoryRscDeploymentCatalog } from '@hile/rsc/host/catalog';
import type { RscPluginLocator } from '@hile/rsc/transport';
import type { HileRscDiscoveryHost } from '@hile/rsc-discovery-hile';

export const DEMO_HOST_SERVICE_KEY = 'test.rsc.host.runtime';
const compositionKey = Symbol.for('test-rsc-host/composition');

export interface DemoHostComposition {
  application: Application;
  deployments: InMemoryRscDeploymentCatalog;
  discovery: HileRscDiscoveryHost;
  locator: RscPluginLocator;
  assetMountPath: string;
}

function globalStore(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>;
}

export function installDemoHostComposition(composition: DemoHostComposition): () => void {
  const store = globalStore();
  if (store[compositionKey]) throw new Error('RSC Demo Host composition is already installed');
  store[compositionKey] = composition;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    if (store[compositionKey] === composition) delete store[compositionKey];
  };
}

export function getDemoHostComposition(): DemoHostComposition {
  const composition = globalStore()[compositionKey];
  if (!composition) throw new Error('RSC Demo Host composition is not ready');
  return composition as DemoHostComposition;
}
