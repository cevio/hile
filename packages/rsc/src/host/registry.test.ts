import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RscPluginManifest } from '../protocol';
import {
  InMemoryRscArtifactCatalog,
  createRscAssetUrls,
  createRemoteClientResolver,
  installRemoteClientResolver,
} from './registry';

function manifest(pluginId = 'org.hile.fixture', buildId = 'build-a'): RscPluginManifest {
  return {
    protocolVersion: 1,
    pluginId,
    buildId,
    runtime: { react: '19.2.8', reactDom: '19.2.8', rsc: '19.2.8' },
    server: { entry: 'server-rsc/index.js', integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
    serverFunctions: [],
    clients: [{
      id: 'src/interactive#default',
      module: 'client-browser/interactive.js',
      ssrModule: 'client-ssr/interactive.js',
      exportName: 'default',
      chunks: [],
      ssrChunks: [],
      integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      ssrIntegrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
    }],
    styles: [{ path: 'client-browser/interactive.css', integrity: 'sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=' }],
    routes: [{ path: '/fixture', entry: 'default' }],
  };
}

describe('RscArtifactCatalog composition', () => {
  it('isolates registrations between catalog instances and returns snapshots', () => {
    const first = new InMemoryRscArtifactCatalog();
    const second = new InMemoryRscArtifactCatalog();
    const source = manifest();
    const unregister = first.register('/tmp/fixture-a', source);

    expect(first.get(source.pluginId, source.buildId)).toMatchObject({ root: path.resolve('/tmp/fixture-a') });
    expect(second.get(source.pluginId, source.buildId)).toBeUndefined();
    first.get(source.pluginId, source.buildId)!.manifest.routes[0].path = '/changed';
    expect(first.get(source.pluginId, source.buildId)!.manifest.routes[0].path).toBe('/fixture');

    unregister();
    unregister();
    expect(first.get(source.pluginId, source.buildId)).toBeUndefined();
  });

  it('rejects duplicate identities without coupling unrelated builds', () => {
    const catalog = new InMemoryRscArtifactCatalog();
    catalog.register('/tmp/a', manifest());
    expect(() => catalog.register('/tmp/b', manifest())).toThrow('already registered');
    expect(() => catalog.register('/tmp/b', manifest('org.hile.fixture', 'build-b'))).not.toThrow();
  });

  it('composes an arbitrary public mount path into immutable asset URLs', () => {
    const urls = createRscAssetUrls('/internal/ui-artifacts');
    expect(urls.manifest('org.hile/a', 'build one')).toBe(
      '/internal/ui-artifacts/org.hile%2Fa/build%20one/plugin.json',
    );
    expect(urls.file('org.hile/a', 'build one', 'client/x y.js')).toBe(
      '/internal/ui-artifacts/org.hile%2Fa/build%20one/file/client/x%20y.js',
    );
  });

  it('builds a resolver from an injected catalog and URL policy', async () => {
    const catalog = new InMemoryRscArtifactCatalog();
    const value = manifest();
    catalog.register('/tmp/plugin-root', value);
    const resolver = createRemoteClientResolver(catalog, createRscAssetUrls('/assets-v2'));
    const descriptor = {
      pluginId: value.pluginId,
      buildId: value.buildId,
      referenceId: value.clients[0].id,
      exportName: 'default',
    };

    const browser = await resolver(descriptor, 'browser');
    expect(browser.moduleUrl).toBe('/assets-v2/org.hile.fixture/build-a/file/client-browser/interactive.js');
    expect(browser.styles[0].href).toBe('/assets-v2/org.hile.fixture/build-a/file/client-browser/interactive.css');
    const ssr = await resolver(descriptor, 'ssr');
    expect(ssr.moduleUrl).toMatch(/^file:\/\/\/tmp\/plugin-root\/client-ssr\/interactive\.js$/);
  });

  it('keeps the newest resolver installed when nested hosts uninstall out of order', () => {
    const original = globalThis.__HILE_RSC_RESOLVE_CLIENT__;
    const first = async () => ({ moduleUrl: '/first.js', styles: [] });
    const second = async () => ({ moduleUrl: '/second.js', styles: [] });
    const removeFirst = installRemoteClientResolver(first);
    const removeSecond = installRemoteClientResolver(second);

    removeFirst();
    expect(globalThis.__HILE_RSC_RESOLVE_CLIENT__).toBe(second);
    removeSecond();
    expect(globalThis.__HILE_RSC_RESOLVE_CLIENT__).toBe(original);
  });

  it('preserves a resolver installed externally between independent host lifecycles', () => {
    const original = globalThis.__HILE_RSC_RESOLVE_CLIENT__;
    const first = async () => ({ moduleUrl: '/first.js', styles: [] });
    const external = async () => ({ moduleUrl: '/external.js', styles: [] });
    const second = async () => ({ moduleUrl: '/second.js', styles: [] });
    const removeFirst = installRemoteClientResolver(first);
    removeFirst();
    globalThis.__HILE_RSC_RESOLVE_CLIENT__ = external;

    const removeSecond = installRemoteClientResolver(second);
    removeSecond();
    expect(globalThis.__HILE_RSC_RESOLVE_CLIENT__).toBe(external);
    globalThis.__HILE_RSC_RESOLVE_CLIENT__ = original;
  });
});
