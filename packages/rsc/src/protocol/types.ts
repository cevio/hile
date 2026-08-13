export const HILE_RSC_PROTOCOL_VERSION = 1 as const;

export interface RscRuntimeCompatibility {
  react: string;
  reactDom: string;
  rsc: string;
}

export interface RscArtifact {
  entry: string;
  integrity: string;
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
}

export interface RscChunkAsset {
  path: string;
  integrity: string;
}

export interface RscStyleAsset {
  path: string;
  integrity: string;
}

export interface RscRouteDefinition {
  path: string;
  entry: string;
}

export interface RscPluginManifest {
  protocolVersion: typeof HILE_RSC_PROTOCOL_VERSION;
  pluginId: string;
  buildId: string;
  runtime: RscRuntimeCompatibility;
  server: RscArtifact;
  clients: RscClientReference[];
  styles: RscStyleAsset[];
  routes: RscRouteDefinition[];
}

export type RscProtocolErrorCode =
  | 'ERR_RSC_INVALID_MANIFEST'
  | 'ERR_RSC_PROTOCOL_VERSION'
  | 'ERR_RSC_RUNTIME_MISMATCH'
  | 'ERR_RSC_DUPLICATE_CLIENT_REFERENCE'
  | 'ERR_RSC_DUPLICATE_STYLE'
  | 'ERR_RSC_DUPLICATE_ROUTE'
  | 'ERR_RSC_UNSAFE_ARTIFACT_PATH'
  | 'ERR_RSC_INVALID_ROUTE';
