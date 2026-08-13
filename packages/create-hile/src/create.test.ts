import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECT_TEMPLATES } from './create';

const templates = path.resolve(import.meta.dirname, '../templates');

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

  it.each(['rsc-host', 'rsc-plugin'])('%s pins the compatible micro runtime major', (template) => {
    const packageJson = JSON.parse(readFileSync(path.join(templates, template, 'package.json'), 'utf8'));
    expect(packageJson.dependencies['@hile/micro']).toBe('^3.0.6');
  });

  it('keeps Next host-only while pinning the private host adapter version', () => {
    const host = JSON.parse(readFileSync(path.join(templates, 'rsc-host/package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(path.join(templates, 'rsc-plugin/package.json'), 'utf8'));
    expect(host.dependencies.next).toBe('16.3.0');
    expect(plugin.dependencies.next).toBeUndefined();
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

  it('ships the complete incremental development composition in both templates', () => {
    const pluginBoot = readFileSync(path.join(templates, 'rsc-plugin/src/services/plugin.boot.ts'), 'utf8');
    const pluginPackage = JSON.parse(readFileSync(path.join(templates, 'rsc-plugin/package.json'), 'utf8'));
    const hostBoot = readFileSync(path.join(templates, 'rsc-host/src/services/runtime.boot.ts'), 'utf8');
    const hostLayout = readFileSync(path.join(templates, 'rsc-host/src/app/layout.tsx'), 'utf8');
    expect(pluginPackage.scripts['dev:rsc']).toContain('hile-rsc-dev');
    expect(pluginBoot).toContain('bindRscPluginDevelopmentState');
    expect(pluginBoot).toContain('bindRscModelDevelopment');
    expect(hostBoot).toContain('bindRscHostDevelopmentState');
    expect(hostBoot).toContain('createRscDevelopmentEventMiddleware');
    expect(hostLayout).toContain('RscDevelopmentReload');
  });
});
