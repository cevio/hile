import type { MicroContractErrorKind, MicroContractPhase, MicroOperationMetadata } from './types.js';

export const MICRO_CONTRACT_ERROR_STATUS = Object.freeze({
  invalidRequest: 'HILE_MICRO_INVALID_REQUEST',
  requestSchemaFailed: 'HILE_MICRO_REQUEST_SCHEMA_FAILED',
  invalidResponse: 'HILE_MICRO_INVALID_RESPONSE',
  responseSchemaFailed: 'HILE_MICRO_RESPONSE_SCHEMA_FAILED',
} as const);

export type MicroContractErrorStatus = typeof MICRO_CONTRACT_ERROR_STATUS[keyof typeof MICRO_CONTRACT_ERROR_STATUS];

export function isMicroContractErrorStatus(status: unknown): status is MicroContractErrorStatus {
  return Object.values(MICRO_CONTRACT_ERROR_STATUS).some((known) => known === status);
}

export function getMicroContractStatusDetails(status: MicroContractErrorStatus): Readonly<{
  phase: 'provider_request' | 'provider_response';
  kind: 'validation' | 'schema';
  recordFailure: boolean;
}> {
  const request = status === MICRO_CONTRACT_ERROR_STATUS.invalidRequest ||
    status === MICRO_CONTRACT_ERROR_STATUS.requestSchemaFailed;
  const schema = status === MICRO_CONTRACT_ERROR_STATUS.requestSchemaFailed ||
    status === MICRO_CONTRACT_ERROR_STATUS.responseSchemaFailed;
  return {
    phase: request ? 'provider_request' : 'provider_response',
    kind: schema ? 'schema' : 'validation',
    recordFailure: status !== MICRO_CONTRACT_ERROR_STATUS.invalidRequest,
  };
}

export class MicroContractError extends Error {
  readonly status: MicroContractErrorStatus;
  readonly phase: MicroContractPhase;
  readonly kind: MicroContractErrorKind;
  readonly namespace: string;
  readonly operation: string;
  readonly path: string;

  constructor(
    metadata: MicroOperationMetadata,
    phase: MicroContractPhase,
    kind: MicroContractErrorKind,
    options?: ErrorOptions,
  ) {
    const request = phase === 'client_request' || phase === 'provider_request';
    super(kind === 'schema'
      ? `Micro ${request ? 'request' : 'response'} schema failed`
      : `Invalid Micro ${request ? 'request' : 'response'}`, options);
    this.name = 'MicroContractError';
    this.phase = phase;
    this.kind = kind;
    this.namespace = metadata.namespace;
    this.operation = metadata.key;
    this.path = metadata.path;
    this.status = request
      ? kind === 'schema' ? MICRO_CONTRACT_ERROR_STATUS.requestSchemaFailed : MICRO_CONTRACT_ERROR_STATUS.invalidRequest
      : kind === 'schema' ? MICRO_CONTRACT_ERROR_STATUS.responseSchemaFailed : MICRO_CONTRACT_ERROR_STATUS.invalidResponse;
  }
}
