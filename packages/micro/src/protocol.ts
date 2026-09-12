import { Exception } from '@hile/message-modem';
import { MICRO_PROTOCOL_MISMATCH } from './contract-errors';

/** Set only by the transport after checking its framework control allowlist. */
export const FRAMEWORK_CONTROL_INVOCATION = Symbol('micro-framework-control-invocation');

export function normalizeMicroProtocol(protocol: unknown): string | undefined {
  if (protocol === undefined) return undefined;
  if (typeof protocol !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(protocol)) {
    throw new Exception(MICRO_PROTOCOL_MISMATCH, 'Invalid Micro message protocol');
  }
  return protocol;
}
