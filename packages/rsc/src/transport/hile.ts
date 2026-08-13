import type { Readable } from 'node:stream';
import type { RscActionRequest, RscRenderRequest } from '../plugin/types';
import type { RscPluginManifest } from '../protocol';
import {
  DEFAULT_RSC_OPERATIONS,
  type RscCallOptions,
  type RscOperationMap,
  type RscPluginClient,
} from './contracts';

export interface HileRscApplication {
  call<T>(
    namespace: string,
    operation: string,
    data: unknown,
    options?: RscCallOptions,
  ): Promise<T>;
  stream(
    namespace: string,
    operation: string,
    data: unknown,
    options?: RscCallOptions,
  ): Promise<Readable>;
}

export function createHileRscPluginClient(
  application: HileRscApplication,
  namespace: string,
  operations: RscOperationMap = DEFAULT_RSC_OPERATIONS,
): RscPluginClient {
  if (!namespace) throw new TypeError('RSC plugin namespace must not be empty');
  return {
    describe(options) {
      return application.call<RscPluginManifest>(namespace, operations.describe, {}, options);
    },
    render(request: RscRenderRequest, options) {
      return application.stream(namespace, operations.render, request, options);
    },
    action(request: RscActionRequest, options) {
      return application.call(namespace, operations.action, request, options);
    },
  };
}

