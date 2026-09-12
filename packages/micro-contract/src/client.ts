import { assertMicroContract, getOperationMetadata } from './contract.js';
import { getMicroContractStatusDetails, isMicroContractErrorStatus, MicroContractError } from './errors.js';
import { normalizeMicroCallOptions } from './options.js';
import type { MicroCaller, MicroClient, MicroContract } from './types.js';
import { validateMicroValue } from './validation.js';

export function createMicroClient<Contract extends MicroContract>(
  caller: MicroCaller,
  contract: Contract,
): MicroClient<Contract> {
  assertMicroContract(contract);
  if (typeof caller?.call !== 'function') throw new TypeError('A structural Micro caller is required');
  const client: Record<string, (input: unknown, options: unknown) => Promise<unknown>> = {};
  for (const [key, operation] of Object.entries(contract.operations)) {
    const metadata = getOperationMetadata(operation);
    client[key] = async (input, options) => {
      const normalized = normalizeMicroCallOptions(options);
      const request = await validateMicroValue(operation, 'input', input, 'client_request', normalized.signal);
      normalized.signal?.throwIfAborted();
      let response: unknown;
      try {
        response = await caller.call(contract.namespace, operation.path, request, normalized);
      } catch (error) {
        normalized.signal?.throwIfAborted();
        let statusProperty: PropertyDescriptor | undefined;
        try {
          statusProperty = typeof error === 'object' && error !== null
            ? Object.getOwnPropertyDescriptor(error, 'status')
            : undefined;
        } catch {
          throw error;
        }
        const status = statusProperty && 'value' in statusProperty ? statusProperty.value : undefined;
        if (isMicroContractErrorStatus(status)) {
          const details = getMicroContractStatusDetails(status);
          throw new MicroContractError(metadata, details.phase, details.kind);
        }
        throw error;
      }
      const output = await validateMicroValue(operation, 'output', response, 'client_response', normalized.signal);
      normalized.signal?.throwIfAborted();
      return output;
    };
  }
  return Object.freeze(client) as MicroClient<Contract>;
}
