import type { McpProviderDefinition } from '../types.js';

export const MCP_PROVIDER_TOPIC_PREFIX = '@hile/mcp/providers/';
export const MCP_OPERATIONS = Object.freeze({
  invoke: '/-/mcp/invoke',
});

export type McpCapabilityKind = 'tool' | 'resource' | 'prompt';

export interface McpManifestCapability {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Readonly<Record<string, unknown>>;
  outputSchema?: Readonly<Record<string, unknown>>;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
  annotations?: Readonly<Record<string, unknown>>;
  scopes?: readonly string[];
  execution?: { timeoutMs?: number; retry: 'never' | 'idempotent-failover' };
}

export interface McpProviderManifest {
  protocol: 1;
  providerId: string;
  displayName?: string;
  instanceId: string;
  namespace: string;
  address: { host: string; port: number };
  fingerprint: string;
  capabilities: {
    tools: readonly McpManifestCapability[];
    resources: readonly McpManifestCapability[];
    prompts: readonly McpManifestCapability[];
  };
}

export interface McpProviderDirectoryConfig {
  id: string;
  displayName?: string;
  directory: string | URL;
}

export type McpProviderInput = McpProviderDefinition | McpProviderDirectoryConfig;

export interface HileMcpProviderApplication {
  readonly namespace: string;
  readonly host: string;
  readonly port?: number;
  register(operation: string, handler: (input: { data: any; signal?: AbortSignal }) => unknown): () => void;
  publish<T>(topic: string, payload: T): Promise<{ unpublish(): Promise<unknown> }>;
  unpublish(topic: string): Promise<void>;
}

export interface HileMcpDiscoveryApplication {
  listRegistryTopicSnapshots(prefix?: string, options?: { signal?: AbortSignal }): Promise<Array<{
    topic: string;
    payload: unknown;
    publishers: Array<{ host: string; port: number }>;
  }>>;
  streamPeer(address: { host: string; port: number }, operation: string, data: unknown, options?: {
    timeout?: number;
    idleTimeout?: number;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<unknown>>;
}

export type McpProviderSnapshotListener = (instances: readonly McpProviderManifest[]) => void;

export interface McpProviderSource {
  start(): Promise<void>;
  snapshot(): readonly McpProviderManifest[];
  subscribe(listener: McpProviderSnapshotListener): () => void;
  stream(instance: McpProviderManifest, operation: string, data: unknown, options?: {
    timeout?: number;
    idleTimeout?: number;
    signal?: AbortSignal;
  }): Promise<AsyncIterable<unknown>>;
  close(): Promise<void>;
}
