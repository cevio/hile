import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HILE_RSC_PROTOCOL_VERSION, HILE_RSC_RUNTIME } from '../protocol';
import { resolveRscPluginArtifact, resolveVerifiedRscPluginArtifact } from './resolve';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const serverSource = 'export default function Page() {}\n';
const serverIntegrity = `sha256-${createHash('sha256').update(serverSource).digest('base64')}`;

function manifest(buildId: string) {
  return {
    protocolVersion: HILE_RSC_PROTOCOL_VERSION,
    pluginId: 'org.hile.fixture',
    buildId,
    runtime: HILE_RSC_RUNTIME,
    server: {
      entry: 'server-rsc/index.js',
      integrity: serverIntegrity,
    },
    serverFunctions: [],
    clients: [],
    styles: [],
    routes: [{ path: '/fixture', entry: 'default' }],
  };
}

async function artifact(root: string, buildId: string, modified = new Date()): Promise<string> {
  const target = path.join(root, buildId);
  await mkdir(path.join(target, 'server-rsc'), { recursive: true });
  await writeFile(path.join(target, 'server-rsc/index.js'), serverSource);
  const manifestPath = path.join(target, 'plugin.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest(buildId), null, 2)}\n`);
  await utimes(manifestPath, modified, modified);
  return target;
}

describe('resolveRscPluginArtifact', () => {
  it('returns a direct artifact without treating it as a build root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-resolve-'));
    roots.push(root);
    const direct = await artifact(root, 'build-a');

    await expect(resolveRscPluginArtifact(direct)).resolves.toBe(direct);
    const manifestPath = path.join(direct, 'plugin.json');
    await expect(resolveRscPluginArtifact(manifestPath, { buildId: 'other-build' }))
      .resolves.toBe(manifestPath);
  });

  it('resolves an explicitly requested safe build ID', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-resolve-'));
    roots.push(root);

    await expect(resolveRscPluginArtifact(root, { buildId: 'release-42' }))
      .resolves.toBe(path.join(root, 'release-42'));
    await expect(resolveRscPluginArtifact(root, { buildId: '../escape' }))
      .rejects.toThrow('buildId contains unsupported characters');
  });

  it('selects the newest valid non-hidden artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-resolve-'));
    roots.push(root);
    const older = await artifact(root, 'build-a', new Date('2026-01-01T00:00:00Z'));
    await artifact(root, '.staging', new Date('2026-04-01T00:00:00Z'));
    await artifact(root, 'development', new Date('2026-03-01T00:00:00Z'));
    await mkdir(path.join(root, 'incomplete'));
    await mkdir(path.join(root, 'invalid'));
    await writeFile(path.join(root, 'invalid/plugin.json'), '{ invalid json');
    const corrupted = await artifact(root, 'corrupted', new Date('2026-03-15T00:00:00Z'));
    await writeFile(path.join(corrupted, 'server-rsc/index.js'), 'corrupted');
    const missing = await artifact(root, 'missing', new Date('2026-03-20T00:00:00Z'));
    await rm(path.join(missing, 'server-rsc/index.js'));
    const newer = await artifact(root, 'release-42', new Date('2026-02-01T00:00:00Z'));

    await expect(resolveVerifiedRscPluginArtifact(root, HILE_RSC_RUNTIME)).resolves.toMatchObject({
      artifactRoot: newer,
      manifest: { buildId: 'release-42' },
    });
    expect(newer).not.toBe(older);
  });

  it('reports the newest real verification error when no candidate is usable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-resolve-'));
    roots.push(root);
    const broken = await artifact(root, 'broken');
    await rm(path.join(broken, 'server-rsc/index.js'));

    await expect(resolveRscPluginArtifact(root))
      .rejects.toThrow('RSC artifact is missing: server-rsc/index.js');
  });
});
