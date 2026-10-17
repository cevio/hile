import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build, context } from 'esbuild';
import { afterEach, describe, expect, it } from 'vitest';
import { createRscClientBuildOptions } from './artifact-assembler';
import { RscModuleGraph } from './module-graph';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function sourceRoot() {
  const cwd = await realpath(await mkdtemp(path.join(tmpdir(), 'hile-rsc-browser-resolution-')));
  roots.push(cwd);
  return cwd;
}

async function bundle(
  cwd: string,
  source: string,
  target: 'browser' | 'ssr' = 'browser',
  alias: Record<string, string> = {},
) {
  const graph = new RscModuleGraph({ cwd, pluginId: 'org.hile.resolution', buildId: () => 'build-a' });
  const entry = path.join(cwd, 'entry.js');
  await writeFile(entry, source);
  const result = await build({
    ...createRscClientBuildOptions([], path.join(cwd, 'out'), target, [graph.boundaryPlugin('client')]),
    entryPoints: [entry],
    alias,
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0].text).toString('base64')}`);
}

describe('browser dependency resolution', () => {
  it.each(['browser', 'ssr'] as const)('keeps built-in fallback specific to the %s target', async (target) => {
    const cwd = await sourceRoot();
    const module = await bundle(cwd, `
      import tls from 'tls';
      import prefixedTls from 'node:tls';
      import { readFile } from 'node:fs';
      export const roots = tls.rootCertificates || 'bundled';
      export const prefixedRoots = prefixedTls.rootCertificates || 'bundled';
      export const readFileType = typeof readFile;
    `, target);

    if (target === 'browser') {
      expect(module.roots).toBe('bundled');
      expect(module.prefixedRoots).toBe('bundled');
      expect(module.readFileType).toBe('undefined');
    } else {
      expect(Array.isArray(module.roots)).toBe(true);
      expect(module.roots.length).toBeGreaterThan(0);
      expect(module.prefixedRoots).toEqual(module.roots);
      expect(module.readFileType).toBe('function');
    }
  });

  it('preserves explicit browser replacements before falling back to empty built-ins', async () => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { tls: './tls.cjs' } }));
    await writeFile(path.join(cwd, 'tls.cjs'), 'module.exports = { rootCertificates: ["browser roots"] };');

    const module = await bundle(cwd, "import tls from 'tls'; export const roots = tls.rootCertificates;");

    expect(module.roots).toEqual(['browser roots']);
  });

  it.each(['js', 'cjs'])('retains disabled .%s modules declared in a package browser map', async (extension) => {
    const cwd = await sourceRoot();
    const filename = `native.${extension}`;
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { [`./${filename}`]: false } }));
    await writeFile(path.join(cwd, filename), 'throw new Error("native implementation must not run");');

    const module = await bundle(cwd, `
      import native from './${filename}';
      export const result = native.engine || 'browser fallback';
    `);

    expect(module.result).toBe('browser fallback');
  });

  it('retains optional requires guarded by try/catch', async () => {
    const cwd = await sourceRoot();
    const module = await bundle(cwd, `
      let engine;
      try { engine = require('missing-optional-engine'); }
      catch { engine = 'browser fallback'; }
      export { engine };
    `);

    expect(module.engine).toBe('browser fallback');
  });

  it.each([
    "'use server'; export const secret = 'disabled';",
    'this source intentionally has invalid syntax {',
  ])('does not inspect disabled browser source: %s', async (source) => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { './native.js': false } }));
    await writeFile(path.join(cwd, 'native.js'), source);

    const module = await bundle(cwd, `
      import native from './native.js';
      export const result = native.engine || 'browser fallback';
    `);

    expect(module.result).toBe('browser fallback');
  });

  it('keeps RSC validation strict for source that is not disabled', async () => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { './other.js': false } }));
    await writeFile(path.join(cwd, 'other.js'), 'module.exports = {};');
    await writeFile(path.join(cwd, 'native.js'), "'use server'; export const secret = 'must not leak';");

    await expect(bundle(cwd, "export { secret } from './native.js';"))
      .rejects.toThrow('defineRscServerFunction');
  });

  it('accepts a package manifest with a UTF-8 BOM', async () => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), '\uFEFF' + JSON.stringify({ browser: { './native.js': false } }));
    await writeFile(path.join(cwd, 'native.js'), "'use server'; export const secret = 'disabled';");

    const module = await bundle(cwd, "import native from './native.js'; export const value = native.value || 'fallback';");

    expect(module.value).toBe('fallback');
  });

  it.each(['legacy', 'legacy/native'])('does not mistake active alias target %s for disabled source', async (specifier) => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { [specifier]: false } }));
    const native = path.join(cwd, 'native.js');
    await writeFile(native, "'use server'; export const secret = 'must not leak';");

    await expect(bundle(cwd, `export { secret } from ${JSON.stringify(specifier)};`, 'browser', {
      legacy: specifier === 'legacy' ? native : cwd,
    }))
      .rejects.toThrow('defineRscServerFunction');
  });

  it('does not inspect a disabled dependency package', async () => {
    const cwd = await sourceRoot();
    const dependency = path.join(cwd, 'node_modules/legacy');
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { legacy: false } }));
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ main: 'index.js' }));
    await writeFile(path.join(dependency, 'index.js'), 'invalid source {');

    const module = await bundle(cwd, "import native from 'legacy'; export const value = native.value || 'fallback';");

    expect(module.value).toBe('fallback');
  });

  it.each(['tls', 'fs/promises'])('does not hide a broken explicit alias for %s', async (specifier) => {
    const cwd = await sourceRoot();

    await expect(bundle(cwd, `import native from ${JSON.stringify(specifier)}; export default native;`, 'browser', {
      [specifier.split('/')[0]]: path.join(cwd, 'missing-implementation'),
    })).rejects.toThrow('Could not resolve');
  });

  it.each([
    { name: 'absolute file', browser: { './native.js': false }, specifier: 'absolute', disabled: false },
    { name: 'bare filename', browser: { 'native.js': false }, specifier: './native.js', disabled: true },
    { name: 'normalized map key', browser: { './other/../native.js': false }, specifier: './native.js', disabled: false },
    { name: 'bare redirection', browser: { legacy: './native.js', './native.js': false }, specifier: 'legacy', disabled: false },
    { name: 'relative redirection', browser: { './legacy.js': './native.js', './native.js': false }, specifier: './legacy.js', disabled: false },
    { name: 'extension-specific mapping', browser: { './native': false }, specifier: './native.js', disabled: false },
  ])('uses native exclusion semantics for $name', async ({ browser, specifier, disabled }) => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser }));
    await writeFile(path.join(cwd, 'native.js'), "'use server'; export default { value: 'must not leak' };");
    await writeFile(path.join(cwd, 'legacy.js'), 'export default {};');
    const input = specifier === 'absolute' ? path.join(cwd, 'native.js') : specifier;
    const result = bundle(cwd, `import native from ${JSON.stringify(input)}; export const value = native.value || 'fallback';`);

    if (disabled) {
      expect((await result).value).toBe('fallback');
    } else {
      await expect(result).rejects.toThrow('defineRscServerFunction');
    }
  });

  it('checks browser exclusions even when SSR has already cached the directive', async () => {
    const cwd = await sourceRoot();
    await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ browser: { './native.js': false } }));
    await writeFile(path.join(cwd, 'native.js'), "'use server'; export const action = defineRscServerFunction(async () => 42);");
    const entry = path.join(cwd, 'entry.js');
    await writeFile(entry, "import * as native from './native.js'; export const value = native.action || 'fallback';");
    const graph = new RscModuleGraph({ cwd, pluginId: 'org.hile.shared', buildId: () => 'build-a' });
    for (const target of ['ssr', 'browser'] as const) {
      const result = await build({
        ...createRscClientBuildOptions([], path.join(cwd, 'out'), target, [graph.boundaryPlugin('client')]),
        entryPoints: [entry],
        write: false,
      });
      if (target === 'browser') {
        const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0].text).toString('base64')}`);
        expect(module.value).toBe('fallback');
      }
    }
  });

  it('reloads browser exclusions and recovers after a failed incremental build', async () => {
    const cwd = await sourceRoot();
    const packageJson = path.join(cwd, 'package.json');
    const excluded = JSON.stringify({ browser: { './native.js': false } });
    await writeFile(packageJson, excluded);
    await writeFile(path.join(cwd, 'native.js'), 'invalid source {');
    const entry = path.join(cwd, 'entry.js');
    await writeFile(entry, "import native from './native.js'; export const value = native.engine || 'fallback';");
    const graph = new RscModuleGraph({ cwd, pluginId: 'org.hile.incremental', buildId: () => 'build-a' });
    const compiler = await context({
      ...createRscClientBuildOptions([], path.join(cwd, 'out'), 'browser', [graph.boundaryPlugin('client')]),
      entryPoints: [entry],
      write: false,
    });
    try {
      await compiler.rebuild();
      await writeFile(packageJson, '{}');
      await expect(compiler.rebuild()).rejects.toThrow();
      await writeFile(packageJson, excluded);
      const result = await compiler.rebuild();
      const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0].text).toString('base64')}`);
      expect(module.value).toBe('fallback');
    } finally {
      await compiler.dispose();
    }
  });

  it.each(['missing-required-engine', 'node:missing-required-engine'])('still rejects required dependency %s', async (specifier) => {
    const cwd = await sourceRoot();

    await expect(bundle(cwd, `import ${JSON.stringify(specifier)};`))
      .rejects.toThrow('Could not resolve');
  });
});
