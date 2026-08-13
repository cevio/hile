import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function manifest(packageName: string) {
  const file = path.resolve(import.meta.dirname, `../../${packageName}/package.json`);
  return JSON.parse(await readFile(file, 'utf8')) as {
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

describe('RSC physical package boundaries', () => {
  it('keeps core independent from build, development and Next adapters', async () => {
    const core = await manifest('rsc');
    const names = new Set([
      ...Object.keys(core.dependencies ?? {}),
      ...Object.keys(core.peerDependencies ?? {}),
    ]);
    expect(names).not.toContain('@hile/rsc-build');
    expect(names).not.toContain('@hile/rsc-development');
    expect(names).not.toContain('@hile/rsc-next');
    expect(names).not.toContain('esbuild');
    expect(names).not.toContain('next');
    expect(names).not.toContain('typescript');
  });

  it('enforces the one-way adapter dependency graph', async () => {
    const build = await manifest('rsc-build');
    const development = await manifest('rsc-development');
    const next = await manifest('rsc-next');
    expect(build.dependencies).toMatchObject({ '@hile/rsc': 'workspace:^' });
    expect(build.dependencies).not.toHaveProperty('@hile/rsc-development');
    expect(build.dependencies).not.toHaveProperty('@hile/rsc-next');
    expect(development.dependencies).toMatchObject({
      '@hile/rsc': 'workspace:^',
      '@hile/rsc-build': 'workspace:^',
    });
    expect(next.dependencies).toEqual({ '@hile/rsc': 'workspace:^' });
  });
});
