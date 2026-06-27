import { decodeResult, assertStoredResult } from './result-codec';
import { CLEAR_IN_FLIGHT_IF_LOCK_OWNER, COMMIT_DONE_IF_LOCK_OWNER } from './scripts';
import { createDoneState, createInFlightState, parseState } from './state';
import type {
  IdempotencyResultCodec,
  IdempotencyState,
  RedisLike,
} from './types';

export type IdempotencyReadResult<T> =
  | { type: 'empty' }
  | { type: 'cached'; data: T }
  | { type: 'mismatch' }
  | { type: 'in-flight'; state: Extract<IdempotencyState<T>, { state: 'IN_FLIGHT' }> };

export class RedisIdempotencyStore {
  constructor(private readonly redis: RedisLike) { }

  public async read<T>(
    key: string,
    fingerprint: string,
    resultCodec: IdempotencyResultCodec<T> | undefined,
  ): Promise<IdempotencyReadResult<T>> {
    const raw = await this.redis.get(key);
    if (!raw) return { type: 'empty' };

    const state = parseState<T>(raw);
    if (state.fingerprint !== fingerprint) return { type: 'mismatch' };
    if (state.state === 'DONE') {
      return { type: 'cached', data: decodeResult(assertStoredResult(state.data), resultCodec) };
    }
    return { type: 'in-flight', state };
  }

  public async markInFlight(
    key: string,
    token: string,
    fingerprint: string,
    lockTtl: number,
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(createInFlightState(token, fingerprint)), 'PX', lockTtl);
  }

  public async commitDoneIfLockOwner<T>(
    key: string,
    lockKey: string,
    token: string,
    fingerprint: string,
    result: T,
    resultTtl: number,
    resultCodec: IdempotencyResultCodec<T> | undefined,
  ): Promise<boolean> {
    const done = createDoneState(fingerprint, result, resultCodec);
    const committed = await this.redis.eval(
      COMMIT_DONE_IF_LOCK_OWNER,
      2,
      key,
      lockKey,
      token,
      JSON.stringify(done),
      resultTtl,
    );
    return committed === 1;
  }

  public async clearInFlightIfLockOwner(
    key: string,
    lockKey: string,
    token: string,
  ): Promise<boolean> {
    const cleared = await this.redis.eval(CLEAR_IN_FLIGHT_IF_LOCK_OWNER, 2, key, lockKey, token);
    return cleared === 1;
  }
}
