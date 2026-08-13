import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RscPluginManifest } from '../protocol';
import { createRscAssetMiddleware, type RscAssetContext } from './assets';
import { InMemoryRscArtifactCatalog } from './registry';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function manifest(): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId: 'org.hile.fixture',
    buildId: 'build-a',
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server-rsc/index.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [{
      id: 'src/interactive#default', module: 'client-browser/entry.js', ssrModule: 'client-ssr/entry.js',
      exportName: 'default', chunks: [{
        path: 'client-browser/chunk.js',
        integrity: 'sha256-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=',
      }],
      ssrChunks: [{
        path: 'client-ssr/chunk.js',
        integrity: 'sha256-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=',
      }],
      integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      ssrIntegrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    }],
    styles: [{ path: 'client-browser/style.css', integrity: 'sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=' }],
    routes: [{ path: '/fixture', entry: 'default' }],
  };
}

function context(requestPath: string): RscAssetContext & { headers: Map<string, string> } {
  const headers = new Map<string, string>();
  return {
    path: requestPath,
    status: 0,
    headers,
    set(name, value) { headers.set(name, value); },
  };
}

describe('RSC asset middleware composition', () => {
  it('delegates outside its injected mount and does not consult the catalog', async () => {
    const catalog = { get: vi.fn() };
    const middleware = createRscAssetMiddleware({ catalog, mountPath: '/artifacts' });
    const ctx = context('/other/path');
    const next = vi.fn(async () => 'next');
    await expect(middleware(ctx, next)).resolves.toBe('next');
    expect(next).toHaveBeenCalledOnce();
    expect(catalog.get).not.toHaveBeenCalled();
  });

  it('serves a manifest and allowlisted files from the injected catalog', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'hile-rsc-assets-'));
    roots.push(root);
    await import('node:fs/promises').then(({ mkdir }) => mkdir(path.join(root, 'client-browser'), { recursive: true }));
    await writeFile(path.join(root, 'client-browser/entry.js'), 'export default 1');
    const catalog = new InMemoryRscArtifactCatalog();
    catalog.register(root, manifest());
    const middleware = createRscAssetMiddleware({ catalog, mountPath: '/artifacts' });

    const manifestContext = context('/artifacts/org.hile.fixture/build-a/plugin.json');
    await middleware(manifestContext, vi.fn());
    expect(manifestContext.status).toBe(200);
    expect(manifestContext.body).toMatchObject({ buildId: 'build-a' });
    expect(manifestContext.body).not.toHaveProperty('server');
    expect(manifestContext.body).not.toHaveProperty('routes');
    expect(manifestContext.body).not.toHaveProperty('clients.0.ssrModule');
    expect(manifestContext.body).not.toHaveProperty('clients.0.ssrChunks');
    expect(manifestContext.headers.get('Cache-Control')).toContain('immutable');

    const fileContext = context('/artifacts/org.hile.fixture/build-a/file/client-browser/entry.js');
    await middleware(fileContext, vi.fn());
    expect(fileContext.status).toBe(200);
    expect(fileContext.type).toBe('text/javascript; charset=utf-8');
    expect(fileContext.body).toMatchObject({ readable: true });
  });

  it.each([
    'server-rsc/index.js',
    'client-ssr/entry.js',
    'client-ssr/chunk.js',
  ])('does not expose private server artifact %s through the public asset endpoint', async (artifact) => {
    const catalog = new InMemoryRscArtifactCatalog();
    catalog.register('/tmp/does-not-matter', manifest());
    const middleware = createRscAssetMiddleware({ catalog, mountPath: '/artifacts' });
    const ctx = context(`/artifacts/org.hile.fixture/build-a/file/${artifact}`);
    await middleware(ctx, vi.fn());
    expect(ctx.status).toBe(404);
  });

  it.each([
    '/artifacts/org.hile.fixture/build-a/file/client-browser/not-listed.js',
    '/artifacts/org.hile.fixture/build-a/file/../secret.js',
    '/artifacts/org.hile.fixture/build-a/file/%2e%2e/secret.js',
    '/artifacts/org.hile.fixture/build-a/file/client-browser%5centry.js',
    '/artifacts/org.hile.fixture/missing/plugin.json',
  ])('returns 404 for unknown or unsafe artifact %s', async (requestPath) => {
    const catalog = new InMemoryRscArtifactCatalog();
    catalog.register('/tmp/does-not-matter', manifest());
    const middleware = createRscAssetMiddleware({ catalog, mountPath: '/artifacts' });
    const ctx = context(requestPath);
    await middleware(ctx, vi.fn());
    expect(ctx.status).toBe(404);
    expect(ctx.body).toBeUndefined();
  });
});
