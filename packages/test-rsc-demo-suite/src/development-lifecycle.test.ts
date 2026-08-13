import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
const read = (relative: string) => readFileSync(path.join(workspaceRoot, relative), 'utf8');

describe('Registry-driven demo lifecycle', () => {
  it('does not keep a static inventory or manual lifecycle controller', () => {
    const runtime = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    const route = read('packages/test-rsc-host/src/app/api/demo/deployments/route.ts');
    expect(runtime).toContain('new HileRscDiscoveryHost');
    expect(runtime).not.toContain('createDemoInventory');
    expect(runtime).not.toContain('DemoDeploymentController');
    expect(route).not.toContain('export async function POST');
  });

  it('uses the shared plugin runtime composition for every plugin', () => {
    for (const packageName of [
      'test-rsc-plugin-capabilities-v1',
      'test-rsc-plugin-capabilities-v2',
      'test-rsc-plugin-isolation',
    ]) {
      const source = read(`packages/${packageName}/src/services/plugin.boot.ts`);
      expect(source).toContain('new HileRscPluginRuntime');
      expect(source).toContain('bindDevelopment:');
      expect(source).toContain('publishArtifact(record.artifactRoot)');
    }
  });
});
