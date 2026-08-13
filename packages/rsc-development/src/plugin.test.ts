import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '@hile/rsc/protocol';
import { bindRscPluginDevelopmentState } from './plugin';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

function manifest(buildId: string): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [], styles: [], routes: [],
  };
}

describe('bindRscPluginDevelopmentState', () => {
  it('publishes the verified artifact location after a renderer revision activates', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-plugin-development-test-'));
    roots.push(root);
    const file = path.join(root, 'state.json');
    await writeFile(file, JSON.stringify({ revisions: [{
      pluginId: 'org.hile.fixture', buildId: 'build-2', namespace: 'fixture.service',
      revision: 2, artifactRoot: './artifact-build-2',
    }] }));
    const service = {
      describe: vi.fn(() => manifest('build-1')),
      activate: vi.fn(),
    };
    const onActivated = vi.fn(async () => undefined);
    const close = await bindRscPluginDevelopmentState(service as never, {
      file,
      namespace: 'fixture.service',
      runtime: manifest('build-1').runtime,
      verify: async () => ({ manifest: manifest('build-2'), files: [] }),
      createRenderer: () => vi.fn() as never,
      onActivated,
    });

    expect(service.activate).toHaveBeenCalledWith(expect.objectContaining({
      manifest: expect.objectContaining({ buildId: 'build-2' }),
    }));
    expect(onActivated).toHaveBeenCalledWith(expect.objectContaining({
      buildId: 'build-2', artifactRoot: path.join(root, 'artifact-build-2'),
    }));
    await close();
  });

  it('retries publication without reactivating an already active renderer', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-plugin-development-retry-'));
    roots.push(root);
    const file = path.join(root, 'state.json');
    await writeFile(file, JSON.stringify({ revisions: [] }));
    const service = { describe: vi.fn(() => manifest('build-1')), activate: vi.fn() };
    const onActivated = vi.fn()
      .mockRejectedValueOnce(new Error('registry offline'))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const close = await bindRscPluginDevelopmentState(service as never, {
      file,
      namespace: 'fixture.service',
      runtime: manifest('build-1').runtime,
      verify: async () => ({ manifest: manifest('build-2'), files: [] }),
      createRenderer: () => vi.fn() as never,
      onActivated,
      onError,
      pollMs: 10,
    });
    await writeFile(file, JSON.stringify({ revisions: [{
      pluginId: 'org.hile.fixture', buildId: 'build-2', namespace: 'fixture.service',
      revision: 2, artifactRoot: './artifact-build-2',
    }] }));
    await vi.waitFor(() => expect(onActivated).toHaveBeenCalledTimes(2));
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'registry offline' }));
    expect(service.activate).toHaveBeenCalledOnce();
    await close();
  });
});
