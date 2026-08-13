import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildRscPlugin } from './build-plugin';
import { inspectRscPluginArtifact, verifyRscPluginArtifact } from '@hile/rsc/artifact';

const fixture = path.resolve(import.meta.dirname, '../fixtures/plugin-basic');
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function buildArtifact() {
  const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-artifact-'));
  roots.push(root);
  const manifest = await buildRscPlugin({
    pluginId: 'org.hile.fixture', buildId: 'build-a', cwd: fixture, entry: 'src/page.tsx', outdir: root,
    routes: [{ path: '/fixture', entry: 'default' }],
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
  });
  return { root, manifest };
}

describe('RSC artifact inspection and verification', () => {
  it('inspects a directory or explicit manifest without executing plugin code', async () => {
    const { root, manifest } = await buildArtifact();
    await expect(inspectRscPluginArtifact(root)).resolves.toEqual(manifest);
    await expect(inspectRscPluginArtifact(path.join(root, 'plugin.json'))).resolves.toEqual(manifest);
  });

  it('verifies protocol, runtime compatibility and every declared integrity', async () => {
    const { root, manifest } = await buildArtifact();
    await expect(verifyRscPluginArtifact(root, manifest.runtime)).resolves.toEqual({
      manifest,
      files: expect.arrayContaining([
        manifest.server.entry,
        ...manifest.clients.flatMap((client) => [
          client.module, client.ssrModule,
          ...client.chunks.map((chunk) => chunk.path),
          ...client.ssrChunks.map((chunk) => chunk.path),
        ]),
        ...manifest.styles.map((style) => style.path),
      ]),
    });
  });

  it('rejects a tampered, missing or symlinked artifact', async () => {
    const { root, manifest } = await buildArtifact();
    await appendFile(path.join(root, manifest.server.entry), '\n// tampered');
    await expect(verifyRscPluginArtifact(root, manifest.runtime)).rejects.toThrow('integrity mismatch');

    const second = await buildArtifact();
    await rm(path.join(second.root, second.manifest.clients[0].module));
    await expect(verifyRscPluginArtifact(second.root, second.manifest.runtime)).rejects.toThrow('missing');

    const third = await buildArtifact();
    const modulePath = path.join(third.root, third.manifest.clients[0].module);
    const originalPath = `${modulePath}.original`;
    await import('node:fs/promises').then(({ rename }) => rename(modulePath, originalPath));
    await symlink(originalPath, modulePath);
    await expect(verifyRscPluginArtifact(third.root, third.manifest.runtime)).rejects.toThrow('symbolic link');

    const fourth = await buildArtifact();
    const serverDirectory = path.join(fourth.root, 'server-rsc');
    const movedDirectory = path.join(fourth.root, 'server-real');
    await import('node:fs/promises').then(({ rename }) => rename(serverDirectory, movedDirectory));
    await symlink(movedDirectory, serverDirectory);
    await expect(verifyRscPluginArtifact(fourth.root, fourth.manifest.runtime)).rejects.toThrow('symbolic link');
  });

  it('rejects an incompatible expected runtime before reading executable assets', async () => {
    const { root } = await buildArtifact();
    await expect(verifyRscPluginArtifact(root, {
      react: '19.2.7', reactDom: '19.2.8', rsc: '19.2.8',
    })).rejects.toThrow('runtime');
  });

  it('rejects invalid JSON and manifest paths outside the artifact root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-artifact-'));
    roots.push(root);
    await writeFile(path.join(root, 'plugin.json'), '{invalid');
    await expect(inspectRscPluginArtifact(root)).rejects.toThrow();
    await expect(inspectRscPluginArtifact(path.join(root, 'missing.json'))).rejects.toThrow();
  });

  it('rejects undeclared files that could bypass the integrity manifest', async () => {
    const { root, manifest } = await buildArtifact();
    await writeFile(path.join(root, 'undeclared.js'), 'export const bypass = true');

    await expect(verifyRscPluginArtifact(root, manifest.runtime))
      .rejects.toThrow('undeclared file');
  });
});
