import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = path.resolve(import.meta.dirname, '../../..');
const packageNames = [
  'test-rsc-host',
  'test-rsc-plugin-capabilities-v1',
  'test-rsc-plugin-capabilities-v2',
  'test-rsc-plugin-isolation',
  'test-rsc-demo-suite',
] as const;

function manifest(packageName: string): Record<string, any> {
  const file = path.join(workspaceRoot, 'packages', packageName, 'package.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
}

function read(relativePath: string): string {
  return readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

const plugins = [
  {
    packageName: 'test-rsc-plugin-capabilities-v1',
    pluginId: 'demo.rsc.capabilities',
    buildId: 'v1',
    namespace: 'demo.rsc.capabilities.v1',
    port: '4211',
    generation: '1',
  },
  {
    packageName: 'test-rsc-plugin-capabilities-v2',
    pluginId: 'demo.rsc.capabilities',
    buildId: 'v2',
    namespace: 'demo.rsc.capabilities.v2',
    port: '4212',
    generation: '2',
  },
  {
    packageName: 'test-rsc-plugin-isolation',
    pluginId: 'demo.rsc.isolation',
    buildId: 'isolation-v1',
    namespace: 'demo.rsc.isolation.v1',
    port: '4213',
    generation: '1',
  },
] as const;

describe('private RSC demo package contracts', () => {
  it('keeps every demo package private and outside npm publication', () => {
    for (const packageName of packageNames) {
      const value = manifest(packageName);
      expect(value.name).toBe(packageName);
      expect(value.name).toMatch(/^test-/);
      expect(value.private).toBe(true);
      expect(value.publishConfig).toBeUndefined();
    }
  });

  it('keeps the public HTTP runtime exclusively in the host package', () => {
    for (const packageName of packageNames) {
      const dependencies = manifest(packageName).dependencies ?? {};
      expect(Object.hasOwn(dependencies, '@hile/http-next')).toBe(packageName === 'test-rsc-host');
    }
  });

  it('uses Ant Design in the host shell and every independently compiled plugin', () => {
    const host = manifest('test-rsc-host');
    expect(host.dependencies.antd).toBe('6.6.0');
    expect(host.dependencies['@ant-design/nextjs-registry']).toBe('1.3.0');

    const layout = read('packages/test-rsc-host/src/app/layout.tsx');
    const shell = read('packages/test-rsc-host/src/app/host-shell.tsx');
    expect(layout).toContain('AntdRegistry');
    expect(shell.startsWith("'use client';")).toBe(true);
    expect(shell).toContain('ConfigProvider');
    expect(shell).toContain('AntdApp');
    expect(shell).toContain('data-testid="host-application-shell"');
    expect(shell).toContain('data-testid="host-plugin-content"');

    for (const { packageName } of plugins) {
      expect(manifest(packageName).dependencies.antd).toBe('6.6.0');
      const pluginRoot = `packages/${packageName}/src/plugin`;
      const clientEntry = packageName.endsWith('v1')
        ? 'capability-panel.tsx'
        : packageName.endsWith('v2')
          ? 'update-panel.tsx'
          : 'isolation-widget.tsx';
      expect(read(`${pluginRoot}/${clientEntry}`)).toMatch(/from 'antd'/);
    }
  });

  it('uses the current Ant Design Timeline item contract without runtime warnings', () => {
    const panel = read('packages/test-rsc-plugin-capabilities-v2/src/plugin/update-panel.tsx');
    const timeline = panel.match(/<Timeline items=\{\[([\s\S]*?)\]\} \/>/)?.[1];
    expect(timeline).toBeTruthy();
    expect(timeline).not.toMatch(/\bchildren\s*:/);
    expect(timeline).toMatch(/\bcontent\s*:/);
  });

  it('builds every plugin independently without Next or HTTP dependencies', () => {
    for (const expected of plugins) {
      const packageRoot = `packages/${expected.packageName}`;
      const pkg = manifest(expected.packageName);
      const dependencies = pkg.dependencies ?? {};
      expect(dependencies.next).toBeUndefined();
      expect(dependencies['@hile/http']).toBeUndefined();
      expect(dependencies['@hile/http-next']).toBeUndefined();
      expect(dependencies.react).toBe('19.2.8');
      expect(dependencies['react-dom']).toBe('19.2.8');
      expect(dependencies['react-server-dom-webpack']).toBe('19.2.8');

      const config = JSON.parse(read(`${packageRoot}/hile-rsc.json`));
      expect(config).toMatchObject({
        pluginId: expected.pluginId,
        buildId: expected.buildId,
        runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
      });
      expect(config.routes).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: '/', entry: expect.any(String) }),
      ]));

      const environment = read(`${packageRoot}/.env`);
      expect(environment).toContain(`MICRO_NAMESPACE=${expected.namespace}`);
      expect(environment).toContain(`PLUGIN_MICRO_PORT=${expected.port}`);
      expect(environment).toContain('REGISTRY_PORT=9876');
      expect(environment).toContain('HILE_ADVERTISE_HOST=127.0.0.1');
      expect(environment).toContain(`RSC_DISCOVERY_GENERATION=${expected.generation}`);
      expect(read(`${packageRoot}/src/services/plugin.boot.ts`)).toContain('generation:');
      expect(read(`${packageRoot}/src/services/plugin.boot.ts`)).not.toMatch(/HttpNext|@hile\/http|createServer/);
    }
  });

  it('uses real env files and exposes a closed-loop development workflow', () => {
    for (const packageName of packageNames.slice(0, 4)) {
      const packageRoot = path.join(workspaceRoot, 'packages', packageName);
      expect(existsSync(path.join(packageRoot, '.env'))).toBe(true);
      expect(existsSync(path.join(packageRoot, '.env.prod'))).toBe(true);
      expect(existsSync(path.join(packageRoot, '_env'))).toBe(false);
      expect(existsSync(path.join(packageRoot, '_env.prod'))).toBe(false);
      expect(manifest(packageName).scripts.dev).toContain('--dev');
    }
    const suite = manifest('test-rsc-demo-suite');
    expect(suite.scripts.dev).toContain('demo.mjs dev');
    const supervisor = read('packages/test-rsc-demo-suite/scripts/demo.mjs');
    expect(supervisor).toContain('createRscDevelopmentProject');
    expect(supervisor).toContain('loadRscBuildConfig');
    expect(supervisor).toContain('developmentProjects.push(project)');
    expect(supervisor).toContain('writeDevelopmentState');
    expect(supervisor).toContain("`.hile-rsc-development-${process.pid}.json`");
    expect(supervisor).toContain("child.once('exit'");
    expect(supervisor).not.toContain('await stopAll();\n      await runDevelopmentBuild()');
    const host = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    expect(host).toContain('HileRscDiscoveryHost');
    expect(host).not.toContain('bindRscHostDevelopmentState');
    expect(host).toContain('createRscDevelopmentEventMiddleware');
    for (const { packageName } of plugins) {
      const plugin = read(`packages/${packageName}/src/services/plugin.boot.ts`);
      expect(plugin).toContain('bindRscPluginDevelopmentState');
      expect(plugin).toContain('bindRscModelDevelopment');
    }
  });

  it('pairs the Next development allowlist with the action gateway origin', async () => {
    const environment = read('packages/test-rsc-host/.env');
    const configuredOrigin = environment.match(/^RSC_DEMO_ORIGIN=(.+)$/m)?.[1];
    expect(configuredOrigin).toBeTruthy();

    const { default: nextConfig } = await import('../../test-rsc-host/next.config');
    expect(nextConfig.allowedDevOrigins).toContain(new URL(configuredOrigin!).hostname);
  });

  it('demonstrates server/client boundaries, chunks, styling, actions and cancellation', () => {
    const v1Root = 'packages/test-rsc-plugin-capabilities-v1/src';
    const page = read(`${v1Root}/plugin/page.tsx`);
    const client = read(`${v1Root}/plugin/capability-panel.tsx`);
    const service = read(`${v1Root}/services/plugin.boot.ts`);
    const actionModel = read(`${v1Root}/models/increment.model.ts`);
    expect(page).toContain('searchParams');
    expect(client.startsWith("'use client';")).toBe(true);
    expect(client).toMatch(/useState|useReducer/);
    expect(client).toContain('useEffect');
    expect(client).toContain('useTransition');
    expect(client).toContain('lazy(');
    expect(client).toContain('.css');
    expect(service).toContain('service.load(');
    expect(service).not.toContain('actions:');
    expect(actionModel).toContain('defineActionModel');
    expect(actionModel).toContain('getModelExecutionContext');
    for (const version of ['v1', 'v2']) {
      const pluginRoot = `packages/test-rsc-plugin-capabilities-${version}/src/plugin`;
      const sources = version === 'v1'
        ? `${read(`${pluginRoot}/page.tsx`)}\n${read(`${pluginRoot}/capability-panel.tsx`)}`
        : `${read(`${pluginRoot}/page.tsx`)}\n${read(`${pluginRoot}/update-panel.tsx`)}`;
      expect(sources).toContain('RscRouteProps');
      expect(sources).toContain('rsc.buildId');
      expect(sources).not.toMatch(new RegExp(`/_hile/rsc/actions/[^'"]+/${version}/`));
    }
  });

  it('demonstrates module-level use server through the Host and the plugin model registry', () => {
    const action = read('packages/test-rsc-plugin-capabilities-v2/src/plugin/actions.ts');
    const client = read('packages/test-rsc-plugin-capabilities-v2/src/plugin/update-panel.tsx');
    const pluginRuntime = read('packages/test-rsc-plugin-capabilities-v2/src/services/plugin.boot.ts');
    const hostRuntime = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    const hostRoute = read('packages/test-rsc-host/src/app/plugins/[pluginId]/[[...path]]/page.tsx');
    const clientRuntime = read('packages/test-rsc-host/src/app/rsc-client-runtime.tsx');

    expect(action.startsWith("'use server';")).toBe(true);
    expect(action).toContain("invokeRscModel('increment'");
    expect(client).toContain('useActionState(incrementWithServerFunction');
    expect(client).toContain('action={formAction}');
    expect(client).not.toContain("fetch(");
    expect(pluginRuntime).toContain('RscArtifactServerFunctionRuntime');
    expect(hostRuntime).toContain('createRscServerFunctionMiddleware');
    expect(hostRuntime).toContain('RscServerFunctionGateway');
    expect(hostRoute).toContain('DemoRscClientRuntime');
    expect(clientRuntime).toContain('RscNextClientRuntime');
    expect(clientRuntime).toContain('renderError=');
  });

  it('composes all optional RSC adapters behind one HttpNext host', () => {
    const runtime = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    const route = read('packages/test-rsc-host/src/app/plugins/[pluginId]/[[...path]]/page.tsx');
    const clientRuntime = read('packages/test-rsc-host/src/app/rsc-client-runtime.tsx');
    expect(runtime.match(/new HttpNext/g)).toHaveLength(1);
    expect(runtime).toContain('createRscAssetMiddleware');
    expect(runtime).toContain('createRscActionMiddleware');
    expect(runtime).toContain('createRscServerFunctionMiddleware');
    expect(runtime).toContain('createCatalogRscPluginLocator');
    expect(runtime).toContain('installRemoteClientResolver');
    expect(route).toContain('params: Promise<');
    expect(route).toContain('searchParams: Promise<');
    expect(route).toContain('getHttpNextRequestSignal');
    expect(route).toContain('idleTimeout:');
    expect(route).toContain('window:');
    expect(clientRuntime).toContain('RscClientRuntimeProvider');
    expect(runtime).toContain('snapshotConcurrency:');
    expect(runtime).toContain('requireGeneration: true');
    expect(runtime).toContain('generationHighWater: discoveryGenerationHighWater');
  });

  it('distributes MCP providers across existing test services and exposes one Host gateway', () => {
    const host = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    const catalog = read('packages/test-rsc-plugin-capabilities-v1/src/services/plugin.boot.ts');
    const orders = read('packages/test-rsc-plugin-isolation/src/services/plugin.boot.ts');
    expect(host).toContain('createMcpGateway');
    expect(host).toContain('createMcpHttpEndpoint');
    expect(host).toContain("path: '/mcp'");
    expect(catalog).toContain('attachMcpProvider');
    expect(catalog).toContain("id: 'catalog'");
    expect(orders).toContain('attachMcpProvider');
    expect(orders).toContain("id: 'orders'");
    expect(read('packages/test-rsc-demo-suite/scripts/demo.mjs')).toContain('capabilities-v1-replica');
  });

  it('makes the new MCP SDK capabilities observable from the existing workbench', () => {
    const host = read('packages/test-rsc-host/src/services/runtime.boot.ts');
    const workbench = read('packages/test-rsc-host/src/app/mcp-workbench.tsx');
    const catalog = read('packages/test-rsc-plugin-capabilities-v1/src/services/plugin.boot.ts');
    const product = read('packages/test-rsc-plugin-capabilities-v1/src/mcps/product.mcp.ts');
    const prompt = read('packages/test-rsc-plugin-capabilities-v1/src/mcps/recommend-products.mcp.ts');
    const orders = read('packages/test-rsc-plugin-isolation/src/services/plugin.boot.ts');

    expect(host).toContain("mode: 'oauth'");
    expect(host).toContain('cacheHints:');
    expect(workbench).toContain('Complete arguments');
    expect(workbench).toContain('Subscribe &amp; mutate');
    expect(workbench).toContain('Toggle live provider');
    expect(workbench).toContain('Inspect OAuth');
    expect(workbench).toContain("notifications/resources/updated");
    expect(product).toContain('completions:');
    expect(prompt).toContain('completions:');
    expect(catalog).toContain('notifyResourceUpdated');
    expect(orders).toContain("id: 'labs'");
  });
});
