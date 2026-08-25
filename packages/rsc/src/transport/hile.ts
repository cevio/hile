import type { Readable } from 'node:stream';
import type {
  RscActionRequest,
  RscRenderRequest,
  RscServerFunctionRequest,
} from '../plugin/types';
import type { RscServerFunctionWireValue } from '../server-functions/codec';
import type { RscPluginManifest } from '../protocol';
import {
  DEFAULT_RSC_OPERATIONS,
  requireRscCallOptions,
  type RscCallOptions,
  type RscOperationMap,
  type RscPluginClient,
} from './contracts';

export interface HileRscApplication {
  call<T>(
    namespace: string,
    operation: string,
    data: unknown,
    options: RscCallOptions,
  ): Promise<T>;
  stream(
    namespace: string,
    operation: string,
    data: unknown,
    options: RscCallOptions,
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
      return application.call<RscPluginManifest>(
        namespace,
        operations.describe,
        {},
        requireRscCallOptions(options, 'RSC plugin describe'),
      );
    },
    render(request: RscRenderRequest, options) {
      return application.stream(
        namespace,
        operations.render,
        request,
        requireRscCallOptions(options, 'RSC plugin render transport'),
      );
    },
    action(request: RscActionRequest, options) {
      return application.call(
        namespace,
        operations.action,
        request,
        requireRscCallOptions(options, 'RSC plugin action transport'),
      );
    },
    serverFunction(request: RscServerFunctionRequest, options) {
      return application.call<RscServerFunctionWireValue>(
        namespace,
        operations.serverFunction,
        request,
        requireRscCallOptions(options, 'RSC plugin server function transport'),
      );
    },
  };
}
