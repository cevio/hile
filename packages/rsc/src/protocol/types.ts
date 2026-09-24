export const HILE_RSC_PROTOCOL_VERSION = 1 as const;

export interface RscRuntimeCompatibility {
  react: string;
  reactDom: string;
  rsc: string;
}

export interface RscArtifact {
  entry: string;
  integrity: string;
  size?: number;
}

export interface RscClientReference {
  id: string;
  module: string;
  ssrModule: string;
  exportName: string;
  chunks: RscChunkAsset[];
  ssrChunks: RscChunkAsset[];
  integrity: string;
  ssrIntegrity: string;
  size?: number;
  ssrSize?: number;
  /** Browser style artifacts reachable from this client boundary. */
  styles?: string[];
}

export interface RscChunkAsset {
  path: string;
  integrity: string;
  size?: number;
}

export interface RscStyleAsset {
  path: string;
  integrity: string;
  size?: number;
  /** Omitted by legacy manifests and therefore treated as plugin-wide. */
  scope?: 'plugin' | 'client';
}

export interface RscServerFunctionReference {
  id: string;
  module: string;
  exportName: string;
  integrity: string;
  size?: number;
}

export type RscRoutePrefetch = 'none' | 'assets' | 'route';

export interface RscRouteDefinition {
  path: string;
  entry: string;
  /** Optional server export that returns framework-neutral document metadata. */
  metadataEntry?: string;
  /** Safe preload policy. `route` additionally permits a side-effect-free Flight prefetch. */
  prefetch?: RscRoutePrefetch;
  /** Build-generated client references reachable from this route entry. */
  clientReferences?: string[];
}

/** Host-agnostic presentation data owned by one immutable plugin build. */
export interface RscPluginMetadata {
  displayName: string;
  description?: string;
  navigation: RscPluginNavigationItem[];
}

/** A plugin-internal destination. The Host owns its public URL and visibility policy. */
export interface RscPluginNavigationItem {
  id: string;
  label: string;
  path: string;
  order?: number;
  group?: string;
}

export interface RscPluginManifest {
  protocolVersion: typeof HILE_RSC_PROTOCOL_VERSION;
  pluginId: string;
  buildId: string;
  runtime: RscRuntimeCompatibility;
  server: RscArtifact;
  serverFunctions: RscServerFunctionReference[];
  clients: RscClientReference[];
  styles: RscStyleAsset[];
  routes: RscRouteDefinition[];
  metadata?: RscPluginMetadata;
}

export type RscProtocolErrorCode =
  | 'ERR_RSC_INVALID_MANIFEST'
  | 'ERR_RSC_PROTOCOL_VERSION'
  | 'ERR_RSC_RUNTIME_MISMATCH'
  | 'ERR_RSC_DUPLICATE_CLIENT_REFERENCE'
  | 'ERR_RSC_DUPLICATE_SERVER_FUNCTION_REFERENCE'
  | 'ERR_RSC_DUPLICATE_STYLE'
  | 'ERR_RSC_DUPLICATE_ROUTE'
  | 'ERR_RSC_INVALID_METADATA'
  | 'ERR_RSC_DUPLICATE_NAVIGATION'
  | 'ERR_RSC_UNSAFE_ARTIFACT_PATH'
  | 'ERR_RSC_INVALID_ROUTE';
