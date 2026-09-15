import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRscClientCaches,
  clearRscClientBuildCache,
  renderRemoteClientSuspense,
  renderRemoteClientErrorFallback,
  resolveRemoteClientAssets,
  preloadRscRouteAssets,
} from './remote-client-boundary';
import React, { Suspense } from 'react';

afterEach(() => {
  clearRscClientCaches();
  vi.unstubAllGlobals();
});

function manifest(referenceId = 'src/counter#default') {
  return {
    clients: [{
      id: referenceId,
      module: 'client-browser/counter.js',
      integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      size: 40,
      chunks: [{
        path: 'client-browser/chunk.js',
        integrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
        size: 20,
      }],
      styles: ['client-browser/style.css'],
    }],
    styles: [{
      path: 'client-browser/style.css',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      size: 10,
      scope: 'client',
    }, {
      path: 'client-browser/unrelated.css',
      integrity: 'sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
      size: 500,
      scope: 'client',
    }],
    routes: [{
      path: '/posts/[slug]',
      entry: 'post',
      prefetch: 'assets',
      clientReferences: [referenceId],
    }],
  };
}

describe('remote RSC client asset cache', () => {
  it('delegates remote loading suspension to the Host without rendering a local fallback', () => {
    const child = React.createElement('span', { 'data-ready': true });
    const renderLoading = vi.fn(() => React.createElement('span', null, 'loading'));
    const identity = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      referenceId: 'src/counter#default',
      exportName: 'default',
    };

    expect(renderRemoteClientSuspense('host', identity, child, renderLoading)).toBe(child);
    expect(renderLoading).not.toHaveBeenCalled();
  });

  it('keeps the backward-compatible remote Suspense boundary by default', () => {
    const child = React.createElement('span', { 'data-ready': true });
    const loading = React.createElement('span', null, 'loading');
    const identity = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      referenceId: 'src/counter#default',
      exportName: 'default',
    };
    const result = renderRemoteClientSuspense('remote', identity, child, () => loading);

    expect(React.isValidElement(result)).toBe(true);
    expect((result as React.ReactElement).type).toBe(Suspense);
    expect((result as React.ReactElement<{ fallback: React.ReactNode }>).props.fallback).toBe(loading);
  });

  it('invokes the Host error renderer with immutable remote identity and retry', () => {
    const error = new Error('remote import failed');
    const retry = vi.fn();
    const renderError = vi.fn(() => 'host-owned-fallback');
    const identity = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      referenceId: 'src/counter#default',
      exportName: 'default',
    };

    expect(renderRemoteClientErrorFallback(error, identity, retry, renderError))
      .toBe('host-owned-fallback');
    expect(renderError).toHaveBeenCalledWith(error, identity, retry);
  });

  it('fetches one immutable manifest per plugin build and clears it explicitly', async () => {
    const fetch = vi.fn(async () => Response.json(manifest()));
    vi.stubGlobal('fetch', fetch);
    const descriptor = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      referenceId: 'src/counter#default',
      exportName: 'default',
    };

    await resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets');
    await resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets');
    expect(fetch).toHaveBeenCalledOnce();

    clearRscClientCaches();
    await resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('evicts the least recently used immutable manifest after the cache bound', async () => {
    const fetch = vi.fn(async () => Response.json(manifest()));
    vi.stubGlobal('fetch', fetch);
    const descriptor = (buildId: string) => ({
      pluginId: 'org.hile.fixture',
      buildId,
      referenceId: 'src/counter#default',
      exportName: 'default',
    });

    await resolveRemoteClientAssets(descriptor('build-0'), '/_hile/rsc/assets');
    for (let index = 1; index <= 64; index++) {
      await resolveRemoteClientAssets(descriptor(`build-${index}`), '/_hile/rsc/assets');
    }
    await resolveRemoteClientAssets(descriptor('build-0'), '/_hile/rsc/assets');

    expect(fetch).toHaveBeenCalledTimes(66);
  });

  it('does not retain a rejected manifest request', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response('failed', { status: 503 }))
      .mockResolvedValueOnce(Response.json(manifest()));
    vi.stubGlobal('fetch', fetch);
    const descriptor = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      referenceId: 'src/counter#default',
      exportName: 'default',
    };

    await expect(resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets'))
      .rejects.toThrow('503');
    await expect(resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets'))
      .resolves.toMatchObject({ moduleUrl: expect.stringContaining('counter.js') });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clears a successful but stale manifest for one build before retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json(manifest('src/other#default')))
      .mockResolvedValueOnce(Response.json(manifest()));
    vi.stubGlobal('fetch', fetch);
    const descriptor = {
      pluginId: 'org.hile.fixture', buildId: 'build-a',
      referenceId: 'src/counter#default', exportName: 'default',
    };
    await expect(resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets'))
      .rejects.toThrow('reference not found');
    clearRscClientBuildCache(descriptor.pluginId, descriptor.buildId, '/_hile/rsc/assets');
    await expect(resolveRemoteClientAssets(descriptor, '/_hile/rsc/assets')).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keeps tuple cache keys distinct when public identities contain colons', async () => {
    const fetch = vi.fn(async () => Response.json(manifest()));
    vi.stubGlobal('fetch', fetch);
    await resolveRemoteClientAssets({
      pluginId: 'org:hile', buildId: 'build-a',
      referenceId: 'src/counter#default', exportName: 'default',
    }, '/_hile/rsc/assets');
    await resolveRemoteClientAssets({
      pluginId: 'org', buildId: 'hile:build-a',
      referenceId: 'src/counter#default', exportName: 'default',
    }, '/_hile/rsc/assets');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('preloads exact-build route assets once within an explicit byte budget', async () => {
    const fetch = vi.fn(async () => Response.json(manifest()));
    const appended: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({})),
      head: { appendChild: vi.fn((link) => appended.push({ ...link })) },
    });

    const input = {
      pluginId: 'org.hile.fixture',
      buildId: 'build-a',
      path: '/posts/hello',
      assetMountPath: '/_hile/rsc/assets/',
      budgetBytes: 70,
    };
    await expect(preloadRscRouteAssets(input)).resolves.toMatchObject({
      status: 'preloaded',
      bytes: 70,
      files: expect.arrayContaining([
        expect.stringContaining('counter.js'),
        expect.stringContaining('chunk.js'),
        expect.stringContaining('style.css'),
      ]),
    });
    await preloadRscRouteAssets(input);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe('/_hile/rsc/assets/org.hile.fixture/build-a/plugin.json');
    expect(appended).toHaveLength(3);
    expect(appended.map(({ rel }) => rel)).toEqual(['preload', 'modulepreload', 'modulepreload']);
  });

  it('skips preload when policy or complete size metadata cannot satisfy the budget', async () => {
    const noPrefetch = manifest();
    noPrefetch.routes[0].prefetch = 'none';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(noPrefetch)));
    await expect(preloadRscRouteAssets({
      pluginId: 'org.hile.fixture', buildId: 'build-a', path: '/posts/hello', budgetBytes: 70,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'policy' });

    clearRscClientCaches();
    const tooLarge = manifest();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(tooLarge)));
    await expect(preloadRscRouteAssets({
      pluginId: 'org.hile.fixture', buildId: 'build-b', path: '/posts/hello', budgetBytes: 69,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'budget', bytes: 70 });
  });

  it('fails closed when route dependency metadata references a missing client', async () => {
    const incomplete = manifest();
    incomplete.routes[0].clientReferences = ['src/missing#default'];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(incomplete)));

    await expect(preloadRscRouteAssets({
      pluginId: 'org.hile.fixture', buildId: 'build-a', path: '/posts/hello', budgetBytes: 70,
    })).resolves.toMatchObject({ status: 'skipped', reason: 'metadata', files: [], bytes: 0 });
  });

  it('bounds preload DOM nodes and removes evicted immutable assets', async () => {
    const manyAssets = manifest();
    manyAssets.styles = [];
    manyAssets.clients[0].styles = [];
    manyAssets.clients[0].size = 1;
    manyAssets.clients[0].chunks = Array.from({ length: 600 }, (_, index) => ({
      path: `client-browser/chunk-${index}.js`,
      integrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      size: 1,
    }));
    const active = new Set<Record<string, unknown>>();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(manyAssets)));
    vi.stubGlobal('document', {
      createElement: vi.fn(() => {
        const link: Record<string, unknown> = {};
        link.remove = () => active.delete(link);
        return link;
      }),
      head: { appendChild: vi.fn((link) => active.add(link)) },
    });

    const options = {
      pluginId: 'org.hile.fixture',
      path: '/posts/hello',
      budgetBytes: 2_000,
      maxFiles: 700,
    };
    await expect(preloadRscRouteAssets({ ...options, buildId: 'build-many-a' }))
      .resolves.toMatchObject({ status: 'preloaded' });
    await expect(preloadRscRouteAssets({ ...options, buildId: 'build-many-b' }))
      .resolves.toMatchObject({ status: 'preloaded' });

    expect(active.size).toBe(1_024);
  });

  it('rejects excessive file fan-out before adding preload links', async () => {
    const manyAssets = manifest();
    manyAssets.styles = [];
    manyAssets.clients[0].styles = [];
    manyAssets.clients[0].size = 0;
    manyAssets.clients[0].chunks = Array.from({ length: 128 }, (_, index) => ({
      path: `client-browser/zero-${index}.js`,
      integrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
      size: 0,
    }));
    const appendChild = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(manyAssets)));
    vi.stubGlobal('document', {
      createElement: vi.fn(() => ({})),
      head: { appendChild },
    });

    await expect(preloadRscRouteAssets({
      pluginId: 'org.hile.fixture', buildId: 'build-fan-out', path: '/posts/hello',
    })).resolves.toMatchObject({ status: 'skipped', reason: 'files' });
    expect(appendChild).not.toHaveBeenCalled();
  });
});
