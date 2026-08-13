import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRscPluginManifest } from '@hile/rsc/protocol';
import { buildRscPlugin } from './build-plugin';

const fixtureDir = path.resolve(import.meta.dirname, '../fixtures/plugin-basic');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function build() {
  const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
  tempDirs.push(outdir);
  const manifest = await buildRscPlugin({
    pluginId: 'com.example.basic',
    buildId: 'build-1',
    cwd: fixtureDir,
    entry: 'src/page.tsx',
    outdir,
    routes: [{ path: '/basic', entry: 'default' }],
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
  });
  return { outdir, manifest };
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function sri(bytes: Buffer | string): string {
  return `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
}

describe('buildRscPlugin', () => {
  it('emits server RSC, browser client, SSR client, CSS, chunks, and plugin manifest', async () => {
    const { outdir, manifest } = await build();

    expect(await exists(path.join(outdir, manifest.server.entry))).toBe(true);
    for (const client of manifest.clients) {
      expect(await exists(path.join(outdir, client.module))).toBe(true);
      expect(await exists(path.join(outdir, client.ssrModule))).toBe(true);
      for (const chunk of client.chunks) {
        expect(await exists(path.join(outdir, chunk.path))).toBe(true);
      }
      for (const chunk of client.ssrChunks) {
        expect(await exists(path.join(outdir, chunk.path))).toBe(true);
      }
    }
    for (const style of manifest.styles) {
      expect(await exists(path.join(outdir, style.path))).toBe(true);
    }
    expect(await exists(path.join(outdir, 'plugin.json'))).toBe(true);
  });

  it('finds every export from the use client entry and uses stable reference ids', async () => {
    const { manifest } = await build();

    expect(manifest.clients.map(({ id, exportName }) => ({ id, exportName })))
      .toEqual([
        { id: 'com.example.basic/src/counter#default', exportName: 'default' },
        { id: 'com.example.basic/src/counter#CounterLabel', exportName: 'CounterLabel' },
      ]);
  });

  it('keeps the client dependency graph out of the RSC server bundle', async () => {
    const { outdir, manifest } = await build();
    const server = await readFile(path.join(outdir, manifest.server.entry), 'utf8');

    expect(server).toContain('registerClientReference');
    expect(server).toContain('com.example.basic/src/counter');
    expect(server).not.toContain('useState');
    expect(server).not.toContain('window.localStorage');
  });

  it('bundles transitive client dependencies and dynamic imports for browser and SSR targets', async () => {
    const { outdir, manifest } = await build();
    const reference = manifest.clients[0];
    const browser = await readFile(path.join(outdir, reference.module), 'utf8');
    const ssr = await readFile(path.join(outdir, reference.ssrModule), 'utf8');
    const browserChunks = await Promise.all(reference.chunks.map((chunk) =>
      readFile(path.join(outdir, chunk.path), 'utf8')));
    const ssrChunks = await Promise.all(reference.ssrChunks.map((chunk) =>
      readFile(path.join(outdir, chunk.path), 'utf8')));

    expect(browser).toContain('useState');
    expect(browser).toContain('transitive-client-helper');
    expect(ssr).toContain('useState');
    expect(browserChunks.join('\n')).toContain('lazy-client-chunk');
    expect(ssrChunks.join('\n')).toContain('lazy-client-chunk');
  });

  it('extracts CSS imported by the client graph', async () => {
    const { outdir, manifest } = await build();

    expect(manifest.styles.length).toBeGreaterThan(0);
    const css = await readFile(path.join(outdir, manifest.styles[0].path), 'utf8');
    expect(css).toContain('.counter');
  });

  it('writes correct integrity for every primary artifact', async () => {
    const { outdir, manifest } = await build();
    const server = await readFile(path.join(outdir, manifest.server.entry));
    expect(manifest.server.integrity).toBe(sri(server));

    for (const client of manifest.clients) {
      expect(client.integrity).toBe(sri(await readFile(path.join(outdir, client.module))));
      expect(client.ssrIntegrity).toBe(sri(await readFile(path.join(outdir, client.ssrModule))));
      for (const chunk of client.chunks) {
        expect(chunk.integrity).toBe(sri(await readFile(path.join(outdir, chunk.path))));
      }
      for (const chunk of client.ssrChunks) {
        expect(chunk.integrity).toBe(sri(await readFile(path.join(outdir, chunk.path))));
      }
    }
    for (const style of manifest.styles) {
      expect(style.integrity).toBe(sri(await readFile(path.join(outdir, style.path))));
    }
  });

  it('writes a manifest that passes the public protocol validator', async () => {
    const { outdir, manifest } = await build();
    const disk = JSON.parse(await readFile(path.join(outdir, 'plugin.json'), 'utf8'));

    expect(disk).toEqual(manifest);
    expect(validateRscPluginManifest(disk, manifest.runtime)).toEqual(manifest);
  });

  it('rejects entry and output paths that escape their roots', async () => {
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(outdir);
    const common = {
      pluginId: 'com.example.basic',
      buildId: 'build-1',
      cwd: fixtureDir,
      routes: [{ path: '/basic', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    } as const;

    await expect(buildRscPlugin({ ...common, entry: '../outside.tsx', outdir }))
      .rejects.toThrow('entry');
    await expect(buildRscPlugin({ ...common, entry: 'src/page.tsx', outdir: fixtureDir }))
      .rejects.toThrow('outdir');
  });

  it('uses collision-resistant entry names for client boundaries with similar paths', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'hile-rsc-source-'));
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(cwd, outdir);
    await mkdir(path.join(cwd, 'src/a'), { recursive: true });
    const client = `'use client'; export default function Boundary() { return null; }\n`;
    await writeFile(path.join(cwd, 'src/a-b.tsx'), client);
    await writeFile(path.join(cwd, 'src/a/b.tsx'), client);
    await writeFile(path.join(cwd, 'src/page.tsx'), `
      import First from './a-b';
      import Second from './a/b';
      export default function Page() { return <><First /><Second /></>; }
    `);

    const result = await buildRscPlugin({
      pluginId: 'org.hile.collision', buildId: 'build-a', cwd, entry: 'src/page.tsx', outdir,
      routes: [{ path: '/fixture', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    });

    expect(result.clients.map(({ module }) => module)).toHaveLength(2);
    expect(new Set(result.clients.map(({ module }) => module)).size).toBe(2);
  });

  it('refuses to build into a non-empty immutable output directory', async () => {
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(outdir);
    await writeFile(path.join(outdir, 'stale.js'), 'stale');

    await expect(buildRscPlugin({
      pluginId: 'com.example.basic', buildId: 'build-1', cwd: fixtureDir,
      entry: 'src/page.tsx', outdir, routes: [{ path: '/basic', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    })).rejects.toThrow('must be empty');
  });

  it('rejects a runtime declaration that does not match the compiler implementation', async () => {
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(outdir);

    await expect(buildRscPlugin({
      pluginId: 'com.example.basic', buildId: 'build-1', cwd: fixtureDir,
      entry: 'src/page.tsx', outdir, routes: [{ path: '/basic', entry: 'default' }],
      runtime: { react: '19.2.7', reactDom: '19.2.8', rsc: '19.2.8' },
    })).rejects.toThrow('compiler=19.2.8');
    expect(await import('node:fs/promises').then(({ readdir }) => readdir(outdir))).toEqual([]);
  });

  it('rejects an entry symlink that escapes the configured source root', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'hile-rsc-source-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'hile-rsc-outside-'));
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(cwd, outside, outdir);
    await writeFile(path.join(outside, 'page.tsx'), 'export default function Page() { return null; }');
    await symlink(path.join(outside, 'page.tsx'), path.join(cwd, 'page.tsx'));

    await expect(buildRscPlugin({
      pluginId: 'org.hile.escape', buildId: 'build-a', cwd, entry: 'page.tsx', outdir,
      routes: [{ path: '/', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    })).rejects.toThrow('symbolic link');
  });

  it('rejects a nested relative source symlink that escapes the configured source root', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'hile-rsc-source-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'hile-rsc-outside-'));
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(cwd, outside, outdir);
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await writeFile(path.join(outside, 'helper.ts'), 'export const value = 1;');
    await symlink(path.join(outside, 'helper.ts'), path.join(cwd, 'src/helper.ts'));
    await writeFile(path.join(cwd, 'src/page.tsx'), `
      import { value } from './helper';
      export default function Page() { return value; }
    `);

    await expect(buildRscPlugin({
      pluginId: 'org.hile.escape', buildId: 'build-a', cwd, entry: 'src/page.tsx', outdir,
      routes: [{ path: '/', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    })).rejects.toThrow('relative import');
  });

  it('detects use client boundaries resolved through TypeScript path aliases', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'hile-rsc-source-'));
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(cwd, outdir);
    await mkdir(path.join(cwd, 'src/ui'), { recursive: true });
    await writeFile(path.join(cwd, 'tsconfig.json'), JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['src/ui/*'] } },
    }));
    await writeFile(path.join(cwd, 'src/ui/boundary.tsx'),
      `'use client'; export default function Boundary() { return null; }\n`);
    await writeFile(path.join(cwd, 'src/page.tsx'), `
      import Boundary from '@ui/boundary';
      export default function Page() { return <Boundary />; }
    `);

    const result = await buildRscPlugin({
      pluginId: 'org.hile.alias', buildId: 'build-a', cwd, entry: 'src/page.tsx', outdir,
      routes: [{ path: '/', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    });

    expect(result.clients.map(({ id }) => id)).toEqual(['org.hile.alias/src/ui/boundary#default']);
    const server = await readFile(path.join(outdir, result.server.entry), 'utf8');
    expect(server).not.toContain('use client');
  });

  it('detects use client boundaries from symlinked package dependencies', async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'hile-rsc-source-'));
    const dependency = await mkdtemp(path.join(tmpdir(), 'hile-rsc-dependency-'));
    const outdir = await mkdtemp(path.join(tmpdir(), 'hile-rsc-build-'));
    tempDirs.push(cwd, dependency, outdir);
    await mkdir(path.join(cwd, 'src'), { recursive: true });
    await mkdir(path.join(cwd, 'node_modules'), { recursive: true });
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({
      name: 'client-package', type: 'module', exports: './index.js',
    }));
    await writeFile(path.join(dependency, 'index.js'),
      `'use client'; export default function Boundary() { return null; }\n`);
    await symlink(dependency, path.join(cwd, 'node_modules/client-package'));
    await writeFile(path.join(cwd, 'src/page.tsx'), `
      import Boundary from 'client-package';
      export default function Page() { return <Boundary />; }
    `);

    const result = await buildRscPlugin({
      pluginId: 'org.hile.dependency', buildId: 'build-a', cwd, entry: 'src/page.tsx', outdir,
      routes: [{ path: '/', entry: 'default' }],
      runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    });

    expect(result.clients.map(({ id }) => id))
      .toEqual(['org.hile.dependency/@dependency/client-package#default']);
  });
});
