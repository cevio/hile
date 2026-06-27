import { encodeResult } from './result-codec';
import type {
  IdempotencyResultCodec,
  IdempotencyState,
} from './types';

export function parseState<T>(raw: string): IdempotencyState<T> {
  return JSON.parse(raw) as IdempotencyState<T>;
}

export function createInFlightState(
  token: string,
  fingerprint: string,
): IdempotencyState {
  return {
    state: 'IN_FLIGHT',
    token,
    fingerprint,
    startedAt: Date.now(),
  };
}

export function createDoneState<T>(
  fingerprint: string,
  result: T,
  resultCodec: IdempotencyResultCodec<T> | undefined,
): IdempotencyState<T> {
  return {
    state: 'DONE',
    fingerprint,
    data: encodeResult(result, resultCodec),
    finishedAt: Date.now(),
  };
}
