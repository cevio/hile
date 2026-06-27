import type {
  IdempotencyResultCodec,
  JsonValue,
  StoredIdempotencyResult,
} from './types';

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

export function encodeResult<T>(value: T, codec?: IdempotencyResultCodec<T>): StoredIdempotencyResult {
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

export function decodeResult<T>(stored: StoredIdempotencyResult, codec?: IdempotencyResultCodec<T>): T {
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

export function assertStoredResult(value: unknown): StoredIdempotencyResult {
  if (typeof value !== 'object' || value === null || !('encoding' in value)) {
    throw new Error('Invalid cached idempotency result');
  }
  const stored = value as StoredIdempotencyResult;
  if (stored.encoding === 'undefined') return stored;
  if (stored.encoding === 'json' && 'value' in stored) return stored;
  if (stored.encoding === 'custom' && typeof stored.value === 'string') return stored;
  throw new Error('Invalid cached idempotency result');
}
