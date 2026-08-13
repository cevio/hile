import {
  HILE_RSC_PROTOCOL_VERSION,
  type RscPluginManifest,
  type RscProtocolErrorCode,
  type RscRuntimeCompatibility,
} from './types';

export class RscProtocolError extends Error {
  public readonly code: RscProtocolErrorCode;

  constructor(code: RscProtocolErrorCode, message: string) {
    super(message);
    this.name = 'RscProtocolError';
    this.code = code;
  }
}

function fail(code: RscProtocolErrorCode, message: string): never {
  throw new RscProtocolError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be a non-empty string`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be an array`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be an object`);
  }
  return value;
}

function validateArtifactPath(value: unknown, field: string): string {
  const artifactPath = requireString(value, field);
  const segments = artifactPath.split('/');
  if (
    artifactPath.startsWith('/')
    || artifactPath.includes('\\')
    || artifactPath.includes(':')
    || artifactPath.includes('%')
    || artifactPath.includes('?')
    || artifactPath.includes('#')
    || /[\0-\x1F\x7F]/.test(artifactPath)
    || !/^[A-Za-z0-9@_./+-]+$/.test(artifactPath)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail('ERR_RSC_UNSAFE_ARTIFACT_PATH', `${field} contains an unsafe artifact path`);
  }
  return artifactPath;
}

function validateClientReferenceId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (
    !/^[A-Za-z0-9@_./+-]+#[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)
    || id.includes('..')
  ) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must identify a module and export`);
  }
  return id;
}

function validateServerFunctionReferenceId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (
    !/^[a-z0-9]+(?:[.-][a-z0-9]+)+\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9@_./+-]+#[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)
    || id.includes('..')
    || id.includes('//')
  ) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must identify a plugin build, module, and export`);
  }
  return id;
}

function validateExportName(value: unknown, field: string): string {
  const exportName = requireString(value, field);
  if (!/^(?:default|[A-Za-z_$][A-Za-z0-9_$]*)$/.test(exportName)) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be a JavaScript export name`);
  }
  return exportName;
}

function validateEntryName(value: unknown, field: string): string {
  const entry = requireString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry) || entry === '.' || entry === '..') {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be a safe entry name`);
  }
  return entry;
}

function validateIntegrity(value: unknown, field: string): string {
  const integrity = requireString(value, field);
  if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(integrity)) {
    fail('ERR_RSC_INVALID_MANIFEST', `${field} must be a sha256 SRI value`);
  }
  return integrity;
}

function validateRuntime(
  value: unknown,
  hostRuntime: RscRuntimeCompatibility,
): RscRuntimeCompatibility {
  const runtime = requireRecord(value, 'runtime');
  const pluginRuntime: RscRuntimeCompatibility = {
    react: requireString(runtime.react, 'runtime.react'),
    reactDom: requireString(runtime.reactDom, 'runtime.reactDom'),
    rsc: requireString(runtime.rsc, 'runtime.rsc'),
  };

  for (const key of ['react', 'reactDom', 'rsc'] as const) {
    if (pluginRuntime[key] !== hostRuntime[key]) {
      fail(
        'ERR_RSC_RUNTIME_MISMATCH',
        `${key} runtime mismatch: plugin=${pluginRuntime[key]}, host=${hostRuntime[key]}`,
      );
    }
  }

  return pluginRuntime;
}

function validateRoutePath(value: unknown, field: string): string {
  const routePath = requireString(value, field);
  const segments = routePath.slice(1).split('/');
  if (
    !routePath.startsWith('/')
    || routePath.startsWith('//')
    || routePath.includes('?')
    || routePath.includes('#')
    || routePath.includes('\\')
    || routePath.includes('%')
    || /[\0-\x1F\x7F]/.test(routePath)
    || (routePath !== '/' && segments.some((segment) => segment === ''))
    || segments.some((segment) => segment === '.' || segment === '..')
    || segments.some((segment) => segment !== '' && !/^[A-Za-z0-9._~-]+$/.test(segment))
  ) {
    fail('ERR_RSC_INVALID_ROUTE', `${field} must be a normalized absolute route path`);
  }
  return routePath;
}

export function validateRscPluginManifest(
  value: unknown,
  hostRuntime: RscRuntimeCompatibility,
): RscPluginManifest {
  const manifest = requireRecord(value, 'manifest');
  if (manifest.protocolVersion !== HILE_RSC_PROTOCOL_VERSION) {
    fail(
      'ERR_RSC_PROTOCOL_VERSION',
      `unsupported RSC protocol version: ${String(manifest.protocolVersion)}`,
    );
  }

  const pluginId = requireString(manifest.pluginId, 'pluginId');
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(pluginId)) {
    fail('ERR_RSC_INVALID_MANIFEST', 'pluginId must be a lowercase namespaced identifier');
  }
  const buildId = requireString(manifest.buildId, 'buildId');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(buildId)) {
    fail('ERR_RSC_INVALID_MANIFEST', 'buildId contains unsupported characters');
  }

  const runtime = validateRuntime(manifest.runtime, hostRuntime);
  const serverValue = requireRecord(manifest.server, 'server');
  const server = {
    entry: validateArtifactPath(serverValue.entry, 'server.entry'),
    integrity: validateIntegrity(serverValue.integrity, 'server.integrity'),
  };

  const serverFunctionIds = new Set<string>();
  const serverFunctionsValue = manifest.serverFunctions === undefined ? [] : manifest.serverFunctions;
  const serverFunctions = requireArray(serverFunctionsValue, 'serverFunctions').map((item, index) => {
    const reference = requireRecord(item, `serverFunctions[${index}]`);
    const id = validateServerFunctionReferenceId(reference.id, `serverFunctions[${index}].id`);
    if (serverFunctionIds.has(id)) {
      fail(
        'ERR_RSC_DUPLICATE_SERVER_FUNCTION_REFERENCE',
        `duplicate server function reference: ${id}`,
      );
    }
    serverFunctionIds.add(id);
    return {
      id,
      module: validateArtifactPath(reference.module, `serverFunctions[${index}].module`),
      exportName: validateExportName(reference.exportName, `serverFunctions[${index}].exportName`),
      integrity: validateIntegrity(reference.integrity, `serverFunctions[${index}].integrity`),
    };
  });

  const clientIds = new Set<string>();
  const clients = requireArray(manifest.clients, 'clients').map((item, index) => {
    const client = requireRecord(item, `clients[${index}]`);
    const id = validateClientReferenceId(client.id, `clients[${index}].id`);
    if (clientIds.has(id)) {
      fail('ERR_RSC_DUPLICATE_CLIENT_REFERENCE', `duplicate client reference: ${id}`);
    }
    clientIds.add(id);
    return {
      id,
      module: validateArtifactPath(client.module, `clients[${index}].module`),
      ssrModule: validateArtifactPath(client.ssrModule, `clients[${index}].ssrModule`),
      exportName: validateExportName(client.exportName, `clients[${index}].exportName`),
      chunks: requireArray(client.chunks, `clients[${index}].chunks`).map((item, chunkIndex) => {
        const chunk = requireRecord(item, `clients[${index}].chunks[${chunkIndex}]`);
        return {
          path: validateArtifactPath(chunk.path, `clients[${index}].chunks[${chunkIndex}].path`),
          integrity: validateIntegrity(
            chunk.integrity,
            `clients[${index}].chunks[${chunkIndex}].integrity`,
          ),
        };
      }),
      ssrChunks: requireArray(client.ssrChunks, `clients[${index}].ssrChunks`).map((item, chunkIndex) => {
        const chunk = requireRecord(item, `clients[${index}].ssrChunks[${chunkIndex}]`);
        return {
          path: validateArtifactPath(chunk.path, `clients[${index}].ssrChunks[${chunkIndex}].path`),
          integrity: validateIntegrity(
            chunk.integrity,
            `clients[${index}].ssrChunks[${chunkIndex}].integrity`,
          ),
        };
      }),
      integrity: validateIntegrity(client.integrity, `clients[${index}].integrity`),
      ssrIntegrity: validateIntegrity(client.ssrIntegrity, `clients[${index}].ssrIntegrity`),
    };
  });

  const stylePaths = new Set<string>();
  const styles = requireArray(manifest.styles, 'styles').map((item, index) => {
    const style = requireRecord(item, `styles[${index}]`);
    const stylePath = validateArtifactPath(style.path, `styles[${index}].path`);
    if (stylePaths.has(stylePath)) {
      fail('ERR_RSC_DUPLICATE_STYLE', `duplicate style artifact: ${stylePath}`);
    }
    stylePaths.add(stylePath);
    return {
      path: stylePath,
      integrity: validateIntegrity(style.integrity, `styles[${index}].integrity`),
    };
  });

  const routeValues = requireArray(manifest.routes, 'routes');
  if (routeValues.length === 0) {
    fail('ERR_RSC_INVALID_ROUTE', 'routes must contain at least one route');
  }
  const routePaths = new Set<string>();
  const routes = routeValues.map((item, index) => {
    const route = requireRecord(item, `routes[${index}]`);
    const routePath = validateRoutePath(route.path, `routes[${index}].path`);
    if (routePaths.has(routePath)) {
      fail('ERR_RSC_DUPLICATE_ROUTE', `duplicate route path: ${routePath}`);
    }
    routePaths.add(routePath);
    return {
      path: routePath,
      entry: validateEntryName(route.entry, `routes[${index}].entry`),
    };
  });

  return {
    protocolVersion: HILE_RSC_PROTOCOL_VERSION,
    pluginId,
    buildId,
    runtime,
    server,
    serverFunctions,
    clients,
    styles,
    routes,
  };
}
