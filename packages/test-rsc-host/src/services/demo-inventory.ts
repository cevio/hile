import path from 'node:path';

export interface DemoDeploymentDefinition {
  pluginId: string;
  buildId: string;
  namespace: string;
  artifactRoot: string;
  initial: boolean;
}

export function createDemoInventory(hostRoot: string): readonly DemoDeploymentDefinition[] {
  const packagesRoot = path.resolve(hostRoot, '..');
  return Object.freeze([
    {
      pluginId: 'demo.rsc.capabilities',
      buildId: 'v1',
      namespace: 'demo.rsc.capabilities.v1',
      artifactRoot: path.join(packagesRoot, 'test-rsc-plugin-capabilities-v1/.hile-rsc/v1'),
      initial: true,
    },
    {
      pluginId: 'demo.rsc.capabilities',
      buildId: 'v2',
      namespace: 'demo.rsc.capabilities.v2',
      artifactRoot: path.join(packagesRoot, 'test-rsc-plugin-capabilities-v2/.hile-rsc/v2'),
      initial: false,
    },
    {
      pluginId: 'demo.rsc.isolation',
      buildId: 'isolation-v1',
      namespace: 'demo.rsc.isolation.v1',
      artifactRoot: path.join(packagesRoot, 'test-rsc-plugin-isolation/.hile-rsc/isolation-v1'),
      initial: true,
    },
  ] satisfies DemoDeploymentDefinition[]);
}
