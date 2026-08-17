import { describe, expect, it } from 'vitest';
import {
  HILE_RSC_PROTOCOL_VERSION,
  RscProtocolError,
  validateRscPluginManifest,
  type RscPluginManifest,
  type RscRuntimeCompatibility,
} from './index';

const hostRuntime: RscRuntimeCompatibility = {
  react: '19.2.8',
  reactDom: '19.2.8',
  rsc: '19.2.8',
};

function createManifest(): RscPluginManifest {
  return {
    protocolVersion: HILE_RSC_PROTOCOL_VERSION,
    pluginId: 'com.example.analytics',
    buildId: '2026-08-12.1',
    runtime: { ...hostRuntime },
    server: {
      entry: 'server-rsc/index.js',
      integrity: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    serverFunctions: [
      {
        id: 'com.example.analytics/2026-08-12.1/src/actions#save',
        module: 'server-functions/src-actions.js',
        exportName: 'save',
        integrity: 'sha256-GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG=',
      },
    ],
    clients: [
      {
        id: 'counter#default',
        module: 'client-browser/counter.js',
        ssrModule: 'client-ssr/counter.js',
        exportName: 'default',
        chunks: [{
          path: 'client-browser/chunk.js',
          integrity: 'sha256-EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE=',
        }],
        ssrChunks: [{
          path: 'client-ssr/chunk.js',
          integrity: 'sha256-FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF=',
        }],
        integrity: 'sha256-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=',
        ssrIntegrity: 'sha256-DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD=',
      },
    ],
    styles: [
      {
        path: 'styles/counter.css',
        integrity: 'sha256-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      },
    ],
    routes: [
      {
        path: '/dashboard',
        entry: 'dashboard',
      },
    ],
  };
}

function expectProtocolError(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected RscProtocolError');
  } catch (error) {
    expect(error).toBeInstanceOf(RscProtocolError);
    expect(error).toMatchObject({ code });
  }
}

describe('validateRscPluginManifest', () => {
  it('accepts bounded plugin metadata and returns a canonical defensive copy', () => {
    const manifest = createManifest();
    const metadata = {
      displayName: 'Analytics',
      description: 'Operational analytics',
      navigation: [
        { id: 'dashboard', label: 'Dashboard', path: '/dashboard', order: 10, group: 'Operations' },
      ],
    };
    (manifest as unknown as { metadata: unknown }).metadata = metadata;

    const validated = validateRscPluginManifest(manifest, hostRuntime) as RscPluginManifest & {
      metadata: typeof metadata;
    };
    metadata.navigation[0].label = 'mutated';

    expect(validated.metadata).toEqual({
      displayName: 'Analytics',
      description: 'Operational analytics',
      navigation: [
        { id: 'dashboard', label: 'Dashboard', path: '/dashboard', order: 10, group: 'Operations' },
      ],
    });
  });

  it('accepts metadata exactly at every public limit using Unicode code points', () => {
    const manifest = createManifest();
    (manifest as unknown as { metadata: unknown }).metadata = {
      displayName: `📊${'a'.repeat(119)}`,
      description: 'd'.repeat(500),
      navigation: [{
        id: 'i'.repeat(64),
        label: 'l'.repeat(120),
        path: '/dashboard',
        order: 1_000_000,
        group: 'g'.repeat(120),
      }],
    };

    expect(validateRscPluginManifest(manifest, hostRuntime).metadata).toMatchObject({
      displayName: `📊${'a'.repeat(119)}`,
      navigation: [{ order: 1_000_000 }],
    });
  });

  it('canonicalizes display-only raw metadata with an empty navigation list', () => {
    const manifest = createManifest();
    (manifest as unknown as { metadata: unknown }).metadata = {
      displayName: 'Background capability',
    };

    expect(validateRscPluginManifest(manifest, hostRuntime).metadata).toEqual({
      displayName: 'Background capability',
      navigation: [],
    });
  });

  it('rejects navigation metadata that targets an undeclared plugin route', () => {
    const manifest = createManifest();
    (manifest as unknown as { metadata: unknown }).metadata = {
      displayName: 'Analytics',
      navigation: [{ id: 'settings', label: 'Settings', path: '/settings' }],
    };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_METADATA',
    );
  });

  it.each([undefined, null, 1, {}])(
    'classifies a non-string navigation path as invalid metadata: %j',
    (path) => {
      const manifest = createManifest();
      (manifest as unknown as { metadata: unknown }).metadata = {
        displayName: 'Analytics',
        navigation: [{ id: 'dashboard', label: 'Dashboard', path }],
      };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_METADATA',
      );
    },
  );

  it('rejects duplicate navigation ids', () => {
    const manifest = createManifest();
    (manifest as unknown as { metadata: unknown }).metadata = {
      displayName: 'Analytics',
      navigation: [
        { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
        { id: 'dashboard', label: 'Dashboard again', path: '/dashboard' },
      ],
    };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_DUPLICATE_NAVIGATION',
    );
  });

  it.each([
    null,
    [],
    { displayName: '', navigation: [] },
    { displayName: 'a'.repeat(121), navigation: [] },
    { displayName: 'Anal\u2028ytics', navigation: [] },
    { displayName: 'Analytics', description: 'a'.repeat(501), navigation: [] },
    { displayName: 'Analytics', navigation: [{ id: '../x', label: 'X', path: '/dashboard' }] },
    { displayName: 'Analytics', navigation: [{ id: 'i'.repeat(65), label: 'X', path: '/dashboard' }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: ' X', path: '/dashboard' }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'l'.repeat(121), path: '/dashboard' }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'Safe\u202eevil', path: '/dashboard' }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'X', path: '/dashboard', group: 'g'.repeat(121) }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'X', path: '/dashboard', group: '\ud800' }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'X', path: '/dashboard', order: 1.5 }] },
    { displayName: 'Analytics', navigation: [{ id: 'x', label: 'X', path: '/dashboard', order: 1_000_001 }] },
    { displayName: 'Analytics', navigation: Array.from({ length: 129 }, (_, index) => ({
      id: `item-${index}`, label: `Item ${index}`, path: '/dashboard',
    })) },
  ])('rejects malformed or unbounded plugin metadata: %#', (metadata) => {
    const manifest = createManifest();
    (manifest as unknown as { metadata: unknown }).metadata = metadata;

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_METADATA',
    );
  });

  it('accepts a valid manifest, returns a canonical copy, and does not mutate input', () => {
    const manifest = createManifest();
    const before = structuredClone(manifest);
    const validated = validateRscPluginManifest(manifest, hostRuntime);

    expect(validated).toEqual(manifest);
    expect(validated).not.toBe(manifest);
    expect(validated.runtime).not.toBe(manifest.runtime);
    expect(validated.clients).not.toBe(manifest.clients);
    expect(validated.clients[0]).not.toBe(manifest.clients[0]);
    expect(manifest).toEqual(before);
  });

  it.each([
    null,
    undefined,
    true,
    1,
    'manifest',
    [],
  ])('rejects a non-object manifest: %j', (manifest) => {
    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it('rejects an unsupported protocol version', () => {
    const manifest = { ...createManifest(), protocolVersion: 2 };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_PROTOCOL_VERSION',
    );
  });

  it.each([undefined, null, '1', 1.1, 0, -1])
    ('rejects malformed protocol version %j', (protocolVersion) => {
      const manifest = { ...createManifest(), protocolVersion };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_PROTOCOL_VERSION',
      );
    });

  it.each([
    '',
    'plugin',
    'Com.Example.Plugin',
    'com..plugin',
    '.com.plugin',
    'com.plugin.',
    'com/plugin',
    'com plugin',
    'com.插件',
  ])('rejects invalid plugin id %j', (pluginId) => {
    const manifest = { ...createManifest(), pluginId };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each(['', '../build', '/build', 'build id', 'build?1', '构建'])
    ('rejects invalid build id %j', (buildId) => {
      const manifest = { ...createManifest(), buildId };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it.each([
    ['react', '19.2.7'],
    ['reactDom', '19.2.7'],
    ['rsc', '19.2.7'],
  ] as const)('requires an exact %s runtime version', (field, version) => {
    const manifest = createManifest();
    manifest.runtime = { ...manifest.runtime, [field]: version };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_RUNTIME_MISMATCH',
    );
  });

  it.each([null, [], '19.2.8'])('rejects malformed runtime %j', (runtime) => {
    const manifest = { ...createManifest(), runtime };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each(['react', 'reactDom', 'rsc'] as const)
    ('rejects a missing %s runtime version', (field) => {
      const manifest = createManifest() as RscPluginManifest & {
        runtime: Partial<RscRuntimeCompatibility>;
      };
      delete manifest.runtime[field];

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it.each([null, [], 'server'])('rejects malformed server artifact %j', (server) => {
    const manifest = { ...createManifest(), server };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each([
    '',
    'sha256-',
    'sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'sha256-!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!=',
  ])('rejects invalid server integrity %j', (integrity) => {
    const manifest = createManifest();
    manifest.server = { ...manifest.server, integrity };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it('rejects duplicate client reference ids', () => {
    const manifest = createManifest();
    manifest.clients.push({ ...manifest.clients[0] });

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_DUPLICATE_CLIENT_REFERENCE',
    );
  });

  it('accepts a missing serverFunctions collection as an empty additive capability', () => {
    const manifest = createManifest() as RscPluginManifest & { serverFunctions?: unknown };
    delete manifest.serverFunctions;

    expect(validateRscPluginManifest(manifest, hostRuntime).serverFunctions).toEqual([]);
  });

  it('rejects duplicate server function reference ids', () => {
    const manifest = createManifest();
    manifest.serverFunctions.push({ ...manifest.serverFunctions[0] });

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_DUPLICATE_SERVER_FUNCTION_REFERENCE',
    );
  });

  it.each([null, {}, 'serverFunctions'])
    ('rejects malformed server function collection %j', (serverFunctions) => {
      const manifest = { ...createManifest(), serverFunctions };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it.each([
    '',
    'actions#save',
    'com.example.analytics/build/src/actions',
    'com.example.analytics/../src/actions#save',
    'com.example.analytics/build/src/actions#not-valid!',
  ])('rejects invalid server function reference id %j', (id) => {
    const manifest = createManifest();
    manifest.serverFunctions[0] = { ...manifest.serverFunctions[0], id };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it('validates server function artifact path and integrity', () => {
    const unsafe = createManifest();
    unsafe.serverFunctions[0] = { ...unsafe.serverFunctions[0], module: '../actions.js' };
    expectProtocolError(
      () => validateRscPluginManifest(unsafe, hostRuntime),
      'ERR_RSC_UNSAFE_ARTIFACT_PATH',
    );

    const invalidIntegrity = createManifest();
    invalidIntegrity.serverFunctions[0] = {
      ...invalidIntegrity.serverFunctions[0],
      integrity: 'sha256-invalid',
    };
    expectProtocolError(
      () => validateRscPluginManifest(invalidIntegrity, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each([null, {}, 'clients'])('rejects malformed clients collection %j', (clients) => {
    const manifest = { ...createManifest(), clients };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each(['', 'counter default', '../counter', 'counter?default'])
    ('rejects invalid client reference id %j', (id) => {
      const manifest = createManifest();
      manifest.clients[0] = { ...manifest.clients[0], id };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it.each(['', 'default export', '../default', 'default?raw'])
    ('rejects invalid client export name %j', (exportName) => {
      const manifest = createManifest();
      manifest.clients[0] = { ...manifest.clients[0], exportName };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it.each([null, {}, 'chunk.js'])('rejects malformed client chunks %j', (chunks) => {
    const manifest = createManifest() as RscPluginManifest & {
      clients: Array<Omit<RscPluginManifest['clients'][number], 'chunks'> & { chunks: unknown }>;
    };
    manifest.clients[0] = { ...manifest.clients[0], chunks };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each([null, {}, 'chunk.js'])('rejects malformed SSR client chunks %j', (ssrChunks) => {
    const manifest = createManifest() as RscPluginManifest & {
      clients: Array<Omit<RscPluginManifest['clients'][number], 'ssrChunks'> & { ssrChunks: unknown }>;
    };
    manifest.clients[0] = { ...manifest.clients[0], ssrChunks };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it.each([
    '../secret.js',
    '/absolute.js',
    'client-browser/../../secret.js',
    'client-browser\\counter.js',
    'client-browser/counter.js?raw',
    'client-browser/counter.js#fragment',
    'client-browser/%2e%2e/secret.js',
    'client-browser/%2Fsecret.js',
    'C:/client-browser/counter.js',
    'client-browser//counter.js',
    'client-browser/./counter.js',
    'client-browser/counter\0.js',
  ])('rejects unsafe artifact path %s', (path) => {
    const manifest = createManifest();
    manifest.clients[0] = { ...manifest.clients[0], module: path };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_UNSAFE_ARTIFACT_PATH',
    );
  });

  it('validates every artifact path location', () => {
    const mutations: Array<(manifest: RscPluginManifest) => void> = [
      (manifest) => { manifest.server.entry = '../server.js'; },
      (manifest) => { manifest.serverFunctions[0].module = '../action.js'; },
      (manifest) => { manifest.clients[0].chunks[0].path = '../chunk.js'; },
      (manifest) => { manifest.styles[0].path = '../style.css'; },
    ];

    for (const mutate of mutations) {
      const manifest = createManifest();
      mutate(manifest);
      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_UNSAFE_ARTIFACT_PATH',
      );
    }
  });

  it.each([null, {}, 'styles'])('rejects malformed styles collection %j', (styles) => {
    const manifest = { ...createManifest(), styles };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it('rejects duplicate style paths', () => {
    const manifest = createManifest();
    manifest.styles.push({ ...manifest.styles[0] });

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_DUPLICATE_STYLE',
    );
  });

  it.each(['dashboard', '//dashboard', '/a/../dashboard', '/dashboard?tab=1'])
    ('rejects invalid route path %s', (path) => {
      const manifest = createManifest();
      manifest.routes[0] = { ...manifest.routes[0], path };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_ROUTE',
      );
    });

  it.each([
    '/a//dashboard',
    '/a/./dashboard',
    '/%2e%2e/dashboard',
    '/dashboard#title',
    '/dashboard\\settings',
    '/dashboard\0',
  ])('rejects route normalization bypass %s', (path) => {
    const manifest = createManifest();
    manifest.routes[0] = { ...manifest.routes[0], path };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_ROUTE',
    );
  });

  it.each([null, {}, 'routes'])('rejects malformed routes collection %j', (routes) => {
    const manifest = { ...createManifest(), routes };

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_MANIFEST',
    );
  });

  it('rejects an empty routes collection', () => {
    const manifest = createManifest();
    manifest.routes = [];

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_INVALID_ROUTE',
    );
  });

  it('rejects duplicate route paths', () => {
    const manifest = createManifest();
    manifest.routes.push({ ...manifest.routes[0] });

    expectProtocolError(
      () => validateRscPluginManifest(manifest, hostRuntime),
      'ERR_RSC_DUPLICATE_ROUTE',
    );
  });

  it.each(['', '../dashboard', 'dashboard entry', 'dashboard?raw'])
    ('rejects invalid route entry %j', (entry) => {
      const manifest = createManifest();
      manifest.routes[0] = { ...manifest.routes[0], entry };

      expectProtocolError(
        () => validateRscPluginManifest(manifest, hostRuntime),
        'ERR_RSC_INVALID_MANIFEST',
      );
    });

  it('exposes a stable structured error shape', () => {
    const error = new RscProtocolError('ERR_RSC_INVALID_MANIFEST', 'invalid');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RscProtocolError');
    expect(error.code).toBe('ERR_RSC_INVALID_MANIFEST');
    expect(error.message).toBe('invalid');
  });
});
