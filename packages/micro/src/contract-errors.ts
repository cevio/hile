import { Exception } from '@hile/message-modem';
import { isMicroContractErrorStatus } from '@hile/micro-contract/internal';

export const MICRO_UNAVAILABLE = 'HILE_MICRO_UNAVAILABLE';
export const MICRO_EXECUTION_FAILED = 'HILE_MICRO_EXECUTION_FAILED';
export const MICRO_PROTOCOL_MISMATCH = 'HILE_MESSAGE_PROTOCOL_MISMATCH';

export class MicroUnavailableError extends Exception {
  constructor() {
    super(MICRO_UNAVAILABLE, 'Micro application is not accepting business requests');
  }
}

export function microErrorStatus(error: unknown): unknown {
  if (!error || typeof error !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'status');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function isNonRetryableMicroError(error: unknown): boolean {
  const status = microErrorStatus(error);
  return isMicroContractErrorStatus(status)
    || status === MICRO_EXECUTION_FAILED
    || status === MICRO_UNAVAILABLE
    || status === MICRO_PROTOCOL_MISMATCH;
}

export function isNeutralMicroError(error: unknown): boolean {
  const status = microErrorStatus(error);
  return status === 'HILE_MICRO_INVALID_REQUEST'
    || status === MICRO_UNAVAILABLE
    || status === MICRO_PROTOCOL_MISMATCH;
}

/** Only framework-owned finite statuses cross the modem with their safe semantics. */
export function toMicroTransportError(error: unknown): unknown {
  const status = microErrorStatus(error);
  if (isMicroContractErrorStatus(status)) {
    return new Exception(status as string, 'Micro contract validation failed');
  }
  if (status === MICRO_PROTOCOL_MISMATCH) {
    return new Exception(MICRO_PROTOCOL_MISMATCH, 'Micro message protocol does not match its route');
  }
  return error;
}
