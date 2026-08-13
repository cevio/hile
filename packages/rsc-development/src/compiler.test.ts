import { cp, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
});
