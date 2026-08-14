import type { ReactNode } from 'react';
import type {
  RscActionRequest,
  RscRenderRequest,
  RscServerFunctionRequest,
} from '../plugin/types';
import type { RscServerFunctionWireValue } from '../server-functions/codec';
import type { RscPluginManifest } from '../protocol';

export interface RscOperationMap {
  describe: string;
  render: string;
  action: string;
  serverFunction: string;
}

export const DEFAULT_RSC_OPERATIONS: Readonly<RscOperationMap> = Object.freeze({
  describe: '/-/rsc/describe',
  render: '/-/rsc/render',
  action: '/-/rsc/action',
  serverFunction: '/-/rsc/server-function',
});

export interface RscCallOptions {
  signal?: AbortSignal;
  /** Maximum total RPC or Flight stream lifetime in milliseconds. */
  timeout?: number;
  /** Maximum time between valid Flight chunks in milliseconds. */
  idleTimeout?: number;
  /** Maximum number of Flight chunks in transit before consumption. */
  window?: number;
}

export interface RscPluginClient {
  describe(options?: RscCallOptions): Promise<RscPluginManifest>;
  render(request: RscRenderRequest, options?: RscCallOptions): Promise<AsyncIterable<Uint8Array>>;
  action(request: RscActionRequest, options?: RscCallOptions): Promise<unknown>;
  serverFunction(
    request: RscServerFunctionRequest,
    options?: RscCallOptions,
  ): Promise<RscServerFunctionWireValue>;
}

export interface RscPluginLocator {
  resolve(
    target: { pluginId: string; buildId: string },
    options?: RscCallOptions,
  ): Promise<RscPluginLease>;
}

export interface RscPluginLease {
  client: RscPluginClient;
  /** Stable identity of the concrete endpoint used to verify an immutable build. */
  verificationKey?: string;
  release(): void | Promise<void>;
}

export interface RscFlightDecodeContext {
  pluginId: string;
  buildId: string;
  signal?: AbortSignal;
}

export interface RscFlightDecoder {
  /** The decoder owns and must consume or close the iterable; its completion releases the build lease. */
  decode(flight: AsyncIterable<Uint8Array>, context: RscFlightDecodeContext): Promise<ReactNode>;
}
