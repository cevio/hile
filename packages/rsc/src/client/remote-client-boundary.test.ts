import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearRscClientCaches,
  clearRscClientBuildCache,
  renderRemoteClientSuspense,
  renderRemoteClientErrorFallback,
  resolveRemoteClientAssets,
} from './remote-client-boundary';
import React, { Suspense } from 'react';

afterEach(() => {
  clearRscClientCaches();
  vi.unstubAllGlobals();
});

function manifest(referenceId = 'src/counter#default') {
  return {
    clients: [{ id: referenceId, module: 'client-browser/counter.js' }],
    styles: [{
      path: 'client-browser/style.css',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
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
});
