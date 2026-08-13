import type { ReactNode } from 'react';
import type { RscActionRequest, RscRenderRequest } from '../plugin/types';
import type { RscPluginManifest } from '../protocol';

export interface RscOperationMap {
  describe: string;
  render: string;
  action: string;
}

export const DEFAULT_RSC_OPERATIONS: Readonly<RscOperationMap> = Object.freeze({
  describe: '/-/rsc/describe',
  render: '/-/rsc/render',
  action: '/-/rsc/action',
});

export interface RscCallOptions {
  signal?: AbortSignal;
}

export interface RscPluginClient {
  describe(options?: RscCallOptions): Promise<RscPluginManifest>;
  render(request: RscRenderRequest, options?: RscCallOptions): Promise<AsyncIterable<Uint8Array>>;
  action(request: RscActionRequest, options?: RscCallOptions): Promise<unknown>;
}

export interface RscPluginLocator {
  resolve(
    target: { pluginId: string; buildId: string },
    options?: RscCallOptions,
  ): Promise<RscPluginLease>;
}

export interface RscPluginLease {
  client: RscPluginClient;
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
