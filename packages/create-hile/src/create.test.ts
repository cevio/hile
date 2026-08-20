import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import * as createModule from './create';

const { PROJECT_TEMPLATES } = createModule;

const templates = path.resolve(import.meta.dirname, '../templates');

describe('project template contracts', () => {
  it('registers every template directory exactly once', () => {
    const directories = readdirSync(templates, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(PROJECT_TEMPLATES.map(({ name }) => name).sort()).toEqual(directories);
  });

  it.each(PROJECT_TEMPLATES.map(({ name }) => name))('%s has normalized application metadata', (template) => {
    const packageJson = JSON.parse(readFileSync(path.join(templates, template, 'package.json'), 'utf8'));
    expect(packageJson).toMatchObject({ private: true, version: '0.1.0', type: 'module' });
    expect(packageJson.engines?.node).toBeTypeOf('string');
  });

  it('uses the current exact React and Next compatibility set', () => {
    for (const template of ['next', 'micro-http-next', 'rsc-host']) {
      const packageJson = JSON.parse(readFileSync(path.join(templates, template, 'package.json'), 'utf8'));
      expect(packageJson.dependencies.next).toBe('16.3.0');
      expect(packageJson.dependencies.react).toBe('19.2.8');
      expect(packageJson.dependencies['react-dom']).toBe('19.2.8');
    }
  });

  it.each(['default', 'micro-http'])('%s loads controllers before listening', (template) => {
    const bootFile = template === 'default' ? 'index.boot.ts' : 'http.boot.ts';
    const source = readFileSync(path.join(templates, template, 'src/services', bootFile), 'utf8');
    expect(source.indexOf('http.load(')).toBeGreaterThan(-1);
    expect(source.indexOf('http.load(')).toBeLessThan(source.indexOf('http.listen('));
  });

  it('keeps the micro-http-next RPC sample namespace configuration-driven', () => {
    const source = readFileSync(
      path.join(templates, 'micro-http-next/src/controllers/post.controller.ts'),
      'utf8',
    );
    expect(source).toContain('process.env.MICRO_NAMESPACE');
    expect(source).not.toContain("app.call('com.zlooks.micro'");
  });

  it('exposes a path-safe generic scaffold API', () => {
    const api = createModule as unknown as Record<string, unknown>;
    expect(api.createHileProject).toBeTypeOf('function');
    expect(api.resolveProjectTarget).toBeTypeOf('function');
    const resolveProjectTarget = api.resolveProjectTarget as (cwd: string, projectName: string) => string;
    expect(() => resolveProjectTarget('/tmp/work', '../escape')).toThrow(/项目名称/);
    expect(resolveProjectTarget('/tmp/work', 'valid-app')).toBe('/tmp/work/valid-app');
  });

  it('provides a check-only latest dependency gate', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(templates, '../../../scripts/update-template-hile-deps.mjs'), '--check'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('全部模板依赖均为 npm latest');
  }, 30_000);
});

describe('RSC project templates', () => {
  it('publishes separate host and plugin architecture roles', () => {
    expect(PROJECT_TEMPLATES.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'rsc-host', 'rsc-plugin',
    ]));
  });

  it.each([
    ['rsc-host', [
      'package.json',
      'src/app/page.tsx',
      'src/app/rsc-client-runtime.tsx',
      'src/app/plugins/[pluginId]/[[...path]]/page.tsx',
      'src/services/runtime.boot.ts',
    ]],
    ['rsc-plugin', [
      'package.json',
      'hile-rsc.json',
      'scripts/dev.mjs',
      'src/services/plugin.boot.ts',
      'src/models/example/increment.model.ts',
    ]],
  ])('%s contains its required composition files', (template, files) => {
    for (const file of files) expect(existsSync(path.join(templates, template, file))).toBe(true);
  });

  it('keeps generated RSC production sources free of domain examples', () => {
    const sources = [
      'rsc-host/src/services/runtime.boot.ts',
      'rsc-host/src/app/page.tsx',
      'rsc-host/src/app/plugins/[pluginId]/[[...path]]/page.tsx',
      'rsc-plugin/src/services/plugin.boot.ts',
      'rsc-plugin/src/plugin/page.tsx',
    ].map((file) => readFileSync(path.join(templates, file), 'utf8')).join('\n');
    expect(sources).not.toMatch(/dashboard|tenant|billing|order|analytics/i);
  });

  it.each(['rsc-host', 'rsc-plugin'])('%s uses the current micro runtime major', (template) => {
    const packageJson = JSON.parse(readFileSync(path.join(templates, template, 'package.json'), 'utf8'));
    expect(packageJson.dependencies['@hile/micro']).toBe('^4.0.0');
  });

  it('keeps Next host-only while pinning the private host adapter version', () => {
    const host = JSON.parse(readFileSync(path.join(templates, 'rsc-host/package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(path.join(templates, 'rsc-plugin/package.json'), 'utf8'));
    expect(host.dependencies.next).toBe('16.3.0');
    expect(plugin.dependencies.next).toBeUndefined();
  });

  it('declares immutable presentation metadata in the RSC plugin build', () => {
    const config = JSON.parse(readFileSync(
      path.join(templates, 'rsc-plugin/hile-rsc.json'),
      'utf8',
    ));

    expect(config.metadata).toEqual({
      displayName: 'Example plugin',
      description: 'An independently deployed Hile RSC plugin',
      navigation: [{ id: 'page', label: 'Example', path: '/page', order: 100 }],
    });
  });

  it('derives Host navigation from active immutable plugin manifests', () => {
    const layout = readFileSync(
      path.join(templates, 'rsc-host/src/app/layout.tsx'),
      'utf8',
    );
    const runtime = readFileSync(
      path.join(templates, 'rsc-host/src/services/runtime.boot.ts'),
      'utf8',
    );

    expect(layout).toContain('listActiveRscPlugins(composition.deployments, composition.artifacts)');
    expect(layout).toContain("href={`/plugins/${encodeURIComponent(plugin.pluginId)}");
    expect(runtime).toContain('return { artifacts, deployments, discovery, locator, assetMountPath };');
  });

  it('scans explicitly marked action models without a handwritten action map', () => {
    const boot = readFileSync(path.join(templates, 'rsc-plugin/src/services/plugin.boot.ts'), 'utf8');
    const model = readFileSync(
      path.join(templates, 'rsc-plugin/src/models/example/increment.model.ts'),
      'utf8',
    );
    expect(boot).toContain('service.load(');
    expect(boot).not.toContain('actions:');
    expect(model).toContain('defineActionModel');
  });

  it('keeps development identity stable and derives production identity from the immutable build', () => {
    const boot = readFileSync(path.join(templates, 'rsc-plugin/src/services/plugin.boot.ts'), 'utf8');
    const developmentEnv = readFileSync(path.join(templates, 'rsc-plugin/_env'), 'utf8');
    const productionEnv = readFileSync(path.join(templates, 'rsc-plugin/_env.prod'), 'utf8');

    expect(developmentEnv).toContain('RSC_INSTANCE_ID=org.example.rsc-plugin.dev');
    expect(productionEnv).not.toMatch(/^MICRO_NAMESPACE=/m);
    expect(productionEnv).not.toMatch(/^RSC_INSTANCE_ID=/m);
    expect(boot).toContain('resolveHileRscPluginIdentity({');
    expect(boot).toContain('namespace: developmentFile ? developmentNamespace : configuredNamespace');
    expect(boot).toContain('instanceId: identity.instanceId');
  });

  it('ships Registry-driven discovery and incremental development composition in both templates', () => {
    const pluginBoot = readFileSync(path.join(templates, 'rsc-plugin/src/services/plugin.boot.ts'), 'utf8');
    const pluginPackage = JSON.parse(readFileSync(path.join(templates, 'rsc-plugin/package.json'), 'utf8'));
    const hostBoot = readFileSync(path.join(templates, 'rsc-host/src/services/runtime.boot.ts'), 'utf8');
    const hostLayout = readFileSync(path.join(templates, 'rsc-host/src/app/layout.tsx'), 'utf8');
    const hostClientRuntime = readFileSync(
      path.join(templates, 'rsc-host/src/app/rsc-client-runtime.tsx'),
      'utf8',
    );
    expect(pluginPackage.scripts['dev:rsc']).toContain('hile-rsc-dev');
    expect(pluginPackage.dependencies['@hile/rsc-discovery-hile']).toBeDefined();
    expect(pluginBoot).toContain('new HileRscPluginRuntime');
    expect(pluginBoot).toContain('bindDevelopment:');
    expect(pluginBoot).toContain('publishArtifact(record.artifactRoot)');
    expect(pluginBoot).toContain('bindRscPluginDevelopmentState');
    expect(pluginBoot).toContain('bindRscModelDevelopment');
    expect(pluginBoot).toContain('generation:');
    expect(hostBoot).toContain('HileRscDiscoveryHost');
    expect(hostBoot).toContain('snapshotConcurrency:');
    expect(hostBoot).toContain('generationHighWater:');
    expect(hostBoot).toContain('RSC_DISCOVERY_REQUIRE_GENERATION');
    expect(readFileSync(path.join(templates, 'rsc-host/_env.prod'), 'utf8'))
      .toContain('RSC_DISCOVERY_REQUIRE_GENERATION=true');
    expect(hostBoot).toContain('createRscDevelopmentEventMiddleware');
    expect(hostBoot).not.toContain('RSC_ARTIFACT_ROOT');
    expect(hostBoot).not.toContain('RSC_PLUGIN_NAMESPACE');
    expect(hostLayout).toContain('RscDevelopmentReload');
    expect(hostClientRuntime.startsWith("'use client';")).toBe(true);
    expect(hostClientRuntime).toContain('renderError=');
  });
});
