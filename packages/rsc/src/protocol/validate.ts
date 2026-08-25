import { HILE_RSC_PLUGIN_METADATA_LIMITS } from './constants';
import {
  HILE_RSC_PROTOCOL_VERSION,
  type RscPluginMetadata,
  type RscPluginManifest,
  type RscProtocolErrorCode,
  type RscRuntimeCompatibility,
} from './types';
import { rscRouteParameterName, splitRscRoutePath } from './route-pattern';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

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
  const reference = /^([^/]+)\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9@_./+-]+#[A-Za-z_$][A-Za-z0-9_$]*$/.exec(id);
  if (
    !reference
    || !PLUGIN_ID_PATTERN.test(reference[1])
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

function validateRoutePath(
  value: unknown,
  field: string,
  errorCode: RscProtocolErrorCode = 'ERR_RSC_INVALID_ROUTE',
): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(errorCode, `${field} must be a non-empty string`);
  }
  const routePath = value;
  const segments = splitRscRoutePath(routePath);
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
    || segments.some((segment) => segment !== ''
      && !/^[A-Za-z0-9._~-]+$/.test(segment)
      && rscRouteParameterName(segment) === undefined)
  ) {
    fail(errorCode, `${field} must be a normalized absolute route path`);
  }
  const parameterNames = segments
    .map(rscRouteParameterName)
    .filter((name): name is string => name !== undefined);
  if (new Set(parameterNames).size !== parameterNames.length) {
    fail(errorCode, `${field} must not repeat a route parameter name`);
  }
  return routePath;
}

function isRouteParameter(segment: string): boolean {
  return rscRouteParameterName(segment) !== undefined;
}

function staticRouteSegmentCount(path: string): number {
  return splitRscRoutePath(path).filter((segment) => !isRouteParameter(segment)).length;
}

function routesOverlap(left: string, right: string): boolean {
  const leftSegments = splitRscRoutePath(left);
  const rightSegments = splitRscRoutePath(right);
  return leftSegments.length === rightSegments.length
    && leftSegments.every((segment, index) => segment === rightSegments[index]
      || isRouteParameter(segment)
      || isRouteParameter(rightSegments[index]));
}

const INVALID_METADATA_TEXT_PATTERN = /[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069]/u;

function exceedsCodePointLength(value: string, maximum: number): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length++;
    if (length > maximum) return true;
  }
  return false;
}

function validateMetadataText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail('ERR_RSC_INVALID_METADATA', `${field} must be a non-empty string`);
  }
  if (
    value !== value.trim()
    || exceedsCodePointLength(value, maxLength)
    || INVALID_METADATA_TEXT_PATTERN.test(value)
  ) {
    fail('ERR_RSC_INVALID_METADATA', `${field} is not a bounded display string`);
  }
  return value;
}

function validatePluginMetadata(
  value: unknown,
  routePaths: ReadonlySet<string>,
): RscPluginMetadata {
  if (!isRecord(value)) {
    fail('ERR_RSC_INVALID_METADATA', 'metadata must be an object');
  }
  const displayName = validateMetadataText(
    value.displayName,
    'metadata.displayName',
    HILE_RSC_PLUGIN_METADATA_LIMITS.displayNameLength,
  );
  const description = value.description === undefined
    ? undefined
    : validateMetadataText(
        value.description,
        'metadata.description',
        HILE_RSC_PLUGIN_METADATA_LIMITS.descriptionLength,
      );
  const navigationValue = value.navigation === undefined ? [] : value.navigation;
  if (
    !Array.isArray(navigationValue)
    || navigationValue.length > HILE_RSC_PLUGIN_METADATA_LIMITS.navigationItems
  ) {
    fail(
      'ERR_RSC_INVALID_METADATA',
      `metadata.navigation must contain at most ${HILE_RSC_PLUGIN_METADATA_LIMITS.navigationItems} items`,
    );
  }
  const navigationIds = new Set<string>();
  const navigation = navigationValue.map((item, index) => {
    if (!isRecord(item)) {
      fail('ERR_RSC_INVALID_METADATA', `metadata.navigation[${index}] must be an object`);
    }
    const id = typeof item.id === 'string' ? item.id : '';
    if (
      id.length > HILE_RSC_PLUGIN_METADATA_LIMITS.navigationIdLength
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
    ) {
      fail('ERR_RSC_INVALID_METADATA', `metadata.navigation[${index}].id is invalid`);
    }
    if (navigationIds.has(id)) {
      fail('ERR_RSC_DUPLICATE_NAVIGATION', `duplicate navigation id: ${id}`);
    }
    navigationIds.add(id);
    const navigationPath = validateRoutePath(
      item.path,
      `metadata.navigation[${index}].path`,
      'ERR_RSC_INVALID_METADATA',
    );
    if (
      !routePaths.has(navigationPath)
      || splitRscRoutePath(navigationPath).some(isRouteParameter)
    ) {
      fail(
        'ERR_RSC_INVALID_METADATA',
        `metadata.navigation[${index}].path must reference a declared static route`,
      );
    }
    if (
      item.order !== undefined
      && (
        !Number.isSafeInteger(item.order)
        || Math.abs(item.order as number)
          > HILE_RSC_PLUGIN_METADATA_LIMITS.navigationOrderMagnitude
      )
    ) {
      fail('ERR_RSC_INVALID_METADATA', `metadata.navigation[${index}].order is invalid`);
    }
    return {
      id,
      label: validateMetadataText(
        item.label,
        `metadata.navigation[${index}].label`,
        HILE_RSC_PLUGIN_METADATA_LIMITS.navigationLabelLength,
      ),
      path: navigationPath,
      ...(item.order === undefined ? {} : { order: item.order as number }),
      ...(item.group === undefined ? {} : {
        group: validateMetadataText(
          item.group,
          `metadata.navigation[${index}].group`,
          HILE_RSC_PLUGIN_METADATA_LIMITS.navigationGroupLength,
        ),
      }),
    };
  });
  return {
    displayName,
    ...(description === undefined ? {} : { description }),
    navigation,
  };
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
  if (!PLUGIN_ID_PATTERN.test(pluginId)) {
    fail('ERR_RSC_INVALID_MANIFEST', 'pluginId must be a lowercase identifier');
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
  for (let left = 0; left < routes.length; left++) {
    for (let right = left + 1; right < routes.length; right++) {
      const leftPath = routes[left].path;
      const rightPath = routes[right].path;
      if (
        routesOverlap(leftPath, rightPath)
        && staticRouteSegmentCount(leftPath) === staticRouteSegmentCount(rightPath)
      ) {
        fail(
          'ERR_RSC_DUPLICATE_ROUTE',
          `ambiguous parameterized routes: ${leftPath} and ${rightPath}`,
        );
      }
    }
  }
  const metadata = manifest.metadata === undefined
    ? undefined
    : validatePluginMetadata(manifest.metadata, routePaths);

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
    ...(metadata === undefined ? {} : { metadata }),
  };
}
