import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  IdempotencyOwnershipLostError,
  IdempotencyPayloadMismatchError,
  IdempotencyRetryableError,
  IdempotencyTimeoutError,
} from './errors';
import { ACQUIRE_OR_READ, COMMIT_IF_OWNER, RELEASE_IF_OWNER } from './scripts';
import type {
  IdempotencyOptions,
  IdempotencyResultCodec,
  IdempotencyState,
  JsonValue,
  RedisLike,
  StoredIdempotencyResult,
} from './types';

type AcquireResult<T> =
  | { type: 'acquired' }
  | { type: 'cached'; data: T }
  | { type: 'mismatch' }
  | { type: 'in-flight' };

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resultSerializationError(path: string, reason: string): TypeError {
  return new TypeError(
    `Idempotency result must be JSON-serializable at ${path}: ${reason}. Provide resultCodec for custom result types.`,
  );
}

function toJsonValue(value: unknown, path = 'result', seen = new WeakSet<object>()): JsonValue {
  if (value === null) return null;

  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw resultSerializationError(path, 'non-finite numbers are not JSON values');
    return value;
  }
  const type = typeof value;
  if (type === 'undefined') throw resultSerializationError(path, 'undefined is only supported as the top-level result');
  if (type === 'bigint' || type === 'symbol' || type === 'function') {
    throw resultSerializationError(path, `${type} is not a JSON value`);
  }

  if (typeof value !== 'object') {
    throw resultSerializationError(path, `${type} is not a JSON value`);
  }
  if (seen.has(value)) {
    throw resultSerializationError(path, 'circular references are not JSON values');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const array: JsonValue[] = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) throw resultSerializationError(`${path}[${i}]`, 'sparse arrays are not JSON values');
      array.push(toJsonValue(value[i], `${path}[${i}]`, seen));
    }
    seen.delete(value);
    return array;
  }

  if (!isPlainObject(value)) {
    seen.delete(value);
    throw resultSerializationError(path, `${Object.prototype.toString.call(value)} is not a plain JSON object`);
  }

  const symbols = Object.getOwnPropertySymbols(value);
  if (symbols.length > 0) {
    seen.delete(value);
    throw resultSerializationError(path, 'symbol keys are not JSON values');
  }

  const object: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(value)) {
    object[key] = toJsonValue(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return object;
}

function encodeResult<T>(value: T, codec?: IdempotencyResultCodec<T>): StoredIdempotencyResult {
  if (codec) {
    const encoded = codec.serialize(value);
    if (typeof encoded !== 'string') {
      throw new TypeError('resultCodec.serialize must return a string');
    }
    return { encoding: 'custom', value: encoded };
  }
  if (value === undefined) return { encoding: 'undefined' };
  return { encoding: 'json', value: toJsonValue(value) };
}

function decodeResult<T>(stored: StoredIdempotencyResult, codec?: IdempotencyResultCodec<T>): T {
  if (stored.encoding === 'undefined') return undefined as T;
  if (stored.encoding === 'json') return stored.value as T;
  if (stored.encoding === 'custom') {
    if (!codec) {
      throw new TypeError('Cached idempotency result requires resultCodec to deserialize');
    }
    return codec.deserialize(stored.value);
  }
  throw new Error('Invalid cached idempotency result');
}

function assertStoredResult(value: unknown): StoredIdempotencyResult {
  if (typeof value !== 'object' || value === null || !('encoding' in value)) {
    throw new Error('Invalid cached idempotency result');
  }
  const stored = value as StoredIdempotencyResult;
  if (stored.encoding === 'undefined') return stored;
  if (stored.encoding === 'json' && 'value' in stored) return stored;
  if (stored.encoding === 'custom' && typeof stored.value === 'string') return stored;
  throw new Error('Invalid cached idempotency result');
}

function normalizeEvalArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Redis idempotency script result');
  }
  return value;
}

function parseState<T>(raw: string): IdempotencyState<T> {
  return JSON.parse(raw) as IdempotencyState<T>;
}

async function acquireOrRead<T>(
  redis: RedisLike,
  key: string,
  token: string,
  fingerprint: string,
  lockTtl: number,
  resultCodec: IdempotencyResultCodec<T> | undefined,
): Promise<AcquireResult<T>> {
  const inFlight: IdempotencyState = {
    state: 'IN_FLIGHT',
    token,
    fingerprint,
    startedAt: Date.now(),
  };
  const result = normalizeEvalArray(
    await redis.eval(ACQUIRE_OR_READ, 1, key, token, fingerprint, JSON.stringify(inFlight), lockTtl),
  );
  const status = result[0];

  if (status === 'ACQUIRED') return { type: 'acquired' };
  if (status === 'MISMATCH') return { type: 'mismatch' };
  if (status === 'IN_FLIGHT') return { type: 'in-flight' };
  if (status === 'CACHED') {
    const raw = result[1];
    if (typeof raw !== 'string') throw new Error('Invalid cached idempotency state');
    const state = parseState<T>(raw);
    if (state.state !== 'DONE') throw new Error('Invalid cached idempotency state');
    return { type: 'cached', data: decodeResult(assertStoredResult(state.data), resultCodec) };
  }

  throw new Error(`Unknown idempotency script status: ${String(status)}`);
}

async function commitIfOwner<T>(
  redis: RedisLike,
  key: string,
  token: string,
  fingerprint: string,
  result: T,
  resultTtl: number,
  resultCodec: IdempotencyResultCodec<T> | undefined,
): Promise<boolean> {
  const done: IdempotencyState<T> = {
    state: 'DONE',
    fingerprint,
    data: encodeResult(result, resultCodec),
    finishedAt: Date.now(),
  };
  const committed = await redis.eval(COMMIT_IF_OWNER, 1, key, token, JSON.stringify(done), resultTtl);
  return committed === 1;
}

async function releaseIfOwner(redis: RedisLike, key: string, token: string): Promise<void> {
  await redis.eval(RELEASE_IF_OWNER, 1, key, token);
}

async function readState<T>(redis: RedisLike, key: string): Promise<IdempotencyState<T> | null> {
  const raw = await redis.get(key);
  if (!raw) return null;
  return parseState<T>(raw);
}

async function waitForResult<T>(
  redis: RedisLike,
  key: string,
  fingerprint: string,
  timeout: number,
  pollInterval: number,
  maxPollInterval: number,
  resultCodec: IdempotencyResultCodec<T> | undefined,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let delay = pollInterval;

  while (Date.now() < deadline) {
    const state = await readState<T>(redis, key);
    if (!state) throw new IdempotencyRetryableError(key);
    if (state.fingerprint !== fingerprint) throw new IdempotencyPayloadMismatchError(key);
    if (state.state === 'DONE') return decodeResult(assertStoredResult(state.data), resultCodec);
    await sleep(delay);
    delay = Math.min(delay * 2, maxPollInterval);
  }

  throw new IdempotencyTimeoutError(key);
}

export async function withIdempotency<T>(
  redis: RedisLike,
  key: string,
  fn: () => Promise<T>,
  options: IdempotencyOptions<T>,
): Promise<T> {
  assertPositiveInteger(options.lockTtl, 'lockTtl');
  assertPositiveInteger(options.resultTtl, 'resultTtl');
  if (!options.fingerprint) throw new TypeError('fingerprint is required');

  const {
    lockTtl,
    resultTtl,
    fingerprint,
    wait = lockTtl,
    onConflict = 'wait',
    pollInterval = 20,
    maxPollInterval = 500,
    resultCodec,
  } = options;
  assertPositiveInteger(wait, 'wait');
  assertPositiveInteger(pollInterval, 'pollInterval');
  assertPositiveInteger(maxPollInterval, 'maxPollInterval');

  const token = randomUUID();
  const acquired = await acquireOrRead<T>(redis, key, token, fingerprint, lockTtl, resultCodec);

  if (acquired.type === 'cached') return acquired.data;
  if (acquired.type === 'mismatch') throw new IdempotencyPayloadMismatchError(key);

  if (acquired.type === 'acquired') {
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      try {
        await releaseIfOwner(redis, key, token);
      } catch (releaseErr) {
        throw new AggregateError(
          [err, releaseErr],
          'Idempotency operation failed and releasing the in-flight key also failed',
        );
      }
      throw err;
    }

    const committed = await commitIfOwner(redis, key, token, fingerprint, result, resultTtl, resultCodec);
    if (!committed) throw new IdempotencyOwnershipLostError(key);
    return result;
  }

  if (onConflict === 'reject') throw new IdempotencyConflictError(key);
  return waitForResult(redis, key, fingerprint, wait, pollInterval, maxPollInterval, resultCodec);
}
