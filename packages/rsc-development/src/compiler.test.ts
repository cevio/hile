import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRscDevelopmentCompiler } from './compiler';

const fixtureDir = path.resolve(import.meta.dirname, '../../rsc-build/fixtures/plugin-basic');
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-development-'));
  const cwd = path.join(root, 'source');
  const outdir = path.join(root, 'output');
  tempDirs.push(root);
  await cp(fixtureDir, cwd, { recursive: true });
  return { cwd, outdir };
}

function options(cwd: string, outdir: string) {
  return {
    pluginId: 'com.example.basic',
    buildId: 'build-1',
    cwd,
    entry: 'src/page.tsx',
    outdir,
    routes: [{ path: '/basic', entry: 'default' }],
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    sessionId: 'test-session',
  } as const;
}

async function exists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

describe('createRscDevelopmentCompiler', () => {
  it('reuses every esbuild context for a warm rebuild without changing client boundaries', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));

    const first = await compiler.rebuild();
    await writeFile(path.join(cwd, 'src/helper.ts'), "export const helperText = 'warm-change';\n");
    const second = await compiler.rebuild();

    expect(first.revision).toBe(1);
    expect(first.contexts).toEqual({ server: 'created', browser: 'created', ssr: 'created' });
    expect(second.revision).toBe(2);
    expect(second.contexts).toEqual({ server: 'reused', browser: 'reused', ssr: 'reused' });
    expect(second.clientGraphChanged).toBe(false);
    expect(second.artifactRoot).not.toBe(first.artifactRoot);
    expect(await exists(path.join(first.artifactRoot, 'plugin.json'))).toBe(true);
    expect(await readFile(path.join(first.artifactRoot, first.manifest.server.entry), 'utf8'))
      .toContain(first.manifest.buildId);
    expect(await readFile(path.join(second.artifactRoot, second.manifest.server.entry), 'utf8'))
      .toContain(second.manifest.buildId);
    expect(await readFile(path.join(second.artifactRoot, second.manifest.clients[0].module), 'utf8'))
      .toContain('warm-change');
    expect(second.manifest.serverFunctions.length).toBeGreaterThan(0);
    const add = second.manifest.serverFunctions.find(({ exportName }) => exportName === 'add')!;
    expect(add.id).toContain(`${second.manifest.buildId}/src/actions#add`);
    expect(await exists(path.join(second.artifactRoot, add.module))).toBe(true);
    expect(await readFile(path.join(second.artifactRoot, second.manifest.clients[0].module), 'utf8'))
      .toContain(add.id);

    await compiler.dispose();
  });

  it('reuses emitted client artifacts when only server source changes and no server references are embedded', async () => {
    const { cwd, outdir } = await fixture();
    const counter = path.join(cwd, 'src/counter.tsx');
    await writeFile(counter, (await readFile(counter, 'utf8'))
      .replace("import { add } from './actions';\n", '')
      .replace("        void add(count).then(({ value }) => window.localStorage.setItem('server-function', String(value)));\n", ''));
    const page = path.join(cwd, 'src/page.tsx');
    const originalPage = await readFile(page, 'utf8');
    await writeFile(page, originalPage
      .replace("import { add } from './actions';\n", '')
      .replace("    React.createElement('pre', null, String(typeof add)),\n", ''));
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));
    const first = await compiler.rebuild();

    await writeFile(page, (await readFile(page, 'utf8')).replace('Plugin server page', 'Edited server page'));
    const second = await compiler.rebuild();

    expect(second.contexts).toEqual({ server: 'reused', browser: 'cached', ssr: 'cached' });
    expect(second.manifest.clients).toEqual(first.manifest.clients);
    expect(await readFile(path.join(second.artifactRoot, second.manifest.server.entry), 'utf8'))
      .toContain('Edited server page');
    await compiler.dispose();
  });

  it('recreates only browser and SSR contexts when the use client entry graph changes', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));
    await compiler.rebuild();
    await writeFile(path.join(cwd, 'src/second.tsx'),
      "'use client'; export default function Second() { return null; }\n");
    await writeFile(path.join(cwd, 'src/page.tsx'), `
      import React from 'react';
      import Counter from './counter';
      import Second from './second';
      export default function Page() {
        return React.createElement('main', null, React.createElement(Counter, { initial: 1 }), React.createElement(Second));
      }
    `);

    const result = await compiler.rebuild();

    expect(result.clientGraphChanged).toBe(true);
    expect(result.contexts).toEqual({ server: 'reused', browser: 'created', ssr: 'created' });
    expect(result.manifest.clients.map((client) => client.id)).toContain('com.example.basic/src/second#default');
    await compiler.dispose();
  });

  it('re-inspects edited directive modules instead of reusing stale export metadata', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));
    await compiler.rebuild();
    const boundary = path.join(cwd, 'src/counter.tsx');
    await writeFile(boundary, `${await readFile(boundary, 'utf8')}\nexport function AddedBoundary() { return null; }\n`);

    const result = await compiler.rebuild();

    expect(result.clientGraphChanged).toBe(true);
    expect(result.contexts).toEqual({ server: 'reused', browser: 'created', ssr: 'created' });
    expect(result.manifest.clients.map(({ id }) => id)).toContain('com.example.basic/src/counter#AddedBoundary');
    await compiler.dispose();
  });

  it('keeps the last successful immutable revision when a rebuild fails', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));
    const first = await compiler.rebuild();
    await writeFile(path.join(cwd, 'src/helper.ts'), 'export const helperText = ;\n');

    await expect(compiler.rebuild()).rejects.toThrow();

    expect(compiler.current()).toEqual(first);
    expect(await exists(path.join(first.artifactRoot, 'plugin.json'))).toBe(true);
    await compiler.dispose();
  });

  it('serializes overlapping rebuild requests into ordered revisions', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));

    const [first, second] = await Promise.all([compiler.rebuild(), compiler.rebuild()]);

    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(second.contexts).toEqual({ server: 'reused', browser: 'reused', ssr: 'reused' });
    await compiler.dispose();
  });

  it('disposes idempotently and rejects later rebuilds', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler(options(cwd, outdir));
    await compiler.rebuild();

    await compiler.dispose();
    await compiler.dispose();

    await expect(compiler.rebuild()).rejects.toThrow('disposed');
    await expect(stat(path.join(outdir, '.work/test-session'))).rejects.toThrow();
  });

  it('bounds immutable revisions and stale compiler sessions', async () => {
    const { cwd, outdir } = await fixture();
    for (const session of ['old-a', 'old-b', 'old-c']) {
      await mkdir(path.join(outdir, 'revisions', session), { recursive: true });
      await mkdir(path.join(outdir, '.work', session), { recursive: true });
    }
    const compiler = await createRscDevelopmentCompiler({
      ...options(cwd, outdir), maxRevisions: 2, maxSessions: 2,
    });
    await compiler.rebuild();
    await compiler.rebuild();
    await compiler.rebuild();

    expect((await readdir(path.join(outdir, 'revisions', 'test-session'))).sort()).toEqual(['r2', 'r3']);
    expect((await readdir(path.join(outdir, 'revisions'))).length).toBeLessThanOrEqual(2);
    expect((await readdir(path.join(outdir, '.work'))).length).toBeLessThanOrEqual(2);
    await compiler.dispose();
  });

  it('rejects a development output symlink that resolves to an ancestor of plugin source', async () => {
    const { cwd } = await fixture();
    const linkParent = await mkdtemp(path.join(tmpdir(), 'hile-rsc-development-link-'));
    tempDirs.push(linkParent);
    const outdir = path.join(linkParent, 'output');
    await symlink(path.dirname(cwd), outdir);

    await expect(createRscDevelopmentCompiler(options(cwd, outdir))).rejects.toThrow('symbolic link');
  });

  it('continues an externally owned revision sequence after compiler reconfiguration', async () => {
    const { cwd, outdir } = await fixture();
    const compiler = await createRscDevelopmentCompiler({
      ...options(cwd, outdir), initialRevision: 7,
    });
    const result = await compiler.rebuild();
    expect(result.revision).toBe(8);
    expect(result.manifest.buildId).toContain('-r8');
    await compiler.dispose();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid initial revision %s', async (initialRevision) => {
    const { cwd, outdir } = await fixture();
    await expect(createRscDevelopmentCompiler({
      ...options(cwd, outdir), initialRevision,
    })).rejects.toThrow('initialRevision');
  });

  it.each([0, 1, 1.5])('rejects invalid retention value %s', async (retention) => {
    const { cwd, outdir } = await fixture();
    await expect(createRscDevelopmentCompiler({
      ...options(cwd, outdir), maxRevisions: retention,
    })).rejects.toThrow('maxRevisions');
  });
});
