import type { RscPluginManifest } from '../protocol';
import type {
  RscServerFunctionReference,
} from '../protocol';
import type { RscServerFunctionWireValue } from '../server-functions/codec';

export interface RscRenderRequest {
  buildId: string;
  path: string;
  params?: Record<string, string | string[]>;
  searchParams?: Record<string, string | string[]>;
}

/** Serializable identity of the immutable deployment rendering a route. */
export interface RscRouteIdentity {
  pluginId: string;
  buildId: string;
}

/** Framework-owned props supplied to every RSC route entry. */
export interface RscRouteProps {
  params: Record<string, string | string[]>;
  searchParams: Record<string, string | string[]>;
  rsc: RscRouteIdentity;
}

export interface RscActionRequest {
  buildId: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface RscServerFunctionRequest {
  buildId: string;
  referenceId: string;
  args: RscServerFunctionWireValue;
}

export interface RscServerFunctionInvocationContext {
  manifest: RscPluginManifest;
  reference: RscServerFunctionReference;
  args: unknown[];
  signal: AbortSignal;
  invokeModel(id: string, input: unknown): Promise<unknown>;
}

export interface RscServerFunctionRuntime {
  invoke(context: RscServerFunctionInvocationContext): Promise<unknown>;
}

export interface RscRenderContext {
  manifest: RscPluginManifest;
  routeEntry: string;
  request: RscRenderRequest;
  signal: AbortSignal;
}

export type RscRenderer = (
  context: RscRenderContext,
) => AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array>>;

export interface RscPluginServiceOptions {
  manifest: RscPluginManifest;
  renderer: RscRenderer;
  serverFunctions?: RscServerFunctionRuntime;
  /** Active plus previous immutable revisions accepted during topology hand-off. */
  retainedRevisions?: number;
}
