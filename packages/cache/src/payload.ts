import type { DefineCacheOptions } from './define';

const PAYLOAD_FLAG = '__$hile_cache';
const PAYLOAD_PREFIX = '\x1fhile-cache:v1:';

type StoredValue<R> = {
  [PAYLOAD_FLAG]: 'value';
  data: R;
  freshUntil?: number;
};

type StoredNegative = {
  [PAYLOAD_FLAG]: 'negative';
};

type PrefixedStoredValue<R> = {
  type: 'value';
  data: R;
  freshUntil?: number;
};

type PrefixedStoredNegative = {
  type: 'negative';
};

export type CacheReadResult<R> =
  | { hit: false }
  | { hit: true; value: R | undefined; stale: boolean };

function getPayloadFlag(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[PAYLOAD_FLAG];
}

function isStoredValue(value: unknown): value is StoredValue<unknown> {
  if (getPayloadFlag(value) !== 'value') return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return 'data' in record
    && typeof record.freshUntil === 'number'
    && keys.every(key => key === PAYLOAD_FLAG || key === 'data' || key === 'freshUntil');
}

function isStoredNegative(value: unknown): value is StoredNegative {
  if (getPayloadFlag(value) !== 'negative') return false;
  return Object.keys(value as Record<string, unknown>).length === 1;
}

function encodePayload(value: PrefixedStoredValue<unknown> | PrefixedStoredNegative): string {
  return `${PAYLOAD_PREFIX}${JSON.stringify(value)}`;
}

function decodePrefixedPayload<R>(text: string): CacheReadResult<R> | undefined {
  if (!text.startsWith(PAYLOAD_PREFIX)) return undefined;

  const stored = JSON.parse(text.slice(PAYLOAD_PREFIX.length)) as PrefixedStoredValue<R> | PrefixedStoredNegative;
  if (stored.type === 'negative') {
    return { hit: true, value: undefined, stale: false };
  }
  if (stored.type !== 'value') {
    throw new Error('Invalid cache payload');
  }
  const freshUntil = typeof stored.freshUntil === 'number' ? stored.freshUntil : undefined;
  return {
    hit: true,
    value: stored.data,
    stale: freshUntil !== undefined && Date.now() > freshUntil,
  };
}

export function resolveNegativeTtl<T extends string, R>(options: DefineCacheOptions<T, R>): number | undefined {
  return options.negative?.ttl;
}

export function resolveRedisTtl<T extends string, R>(expire: number, options: DefineCacheOptions<T, R>): number {
  if (expire <= 0) return 0;
  return expire + (options.stale?.ttl ?? 0);
}

export function encodeCacheValue<T extends string, R>(
  data: R,
  expire: number,
  options: DefineCacheOptions<T, R>,
): string {
  if (!options.stale || expire <= 0) return JSON.stringify(data);
  return encodePayload({
    type: 'value',
    data,
    freshUntil: Date.now() + expire * 1000,
  } satisfies PrefixedStoredValue<R>);
}

export function encodeNegative(): string {
  return encodePayload({ type: 'negative' } satisfies PrefixedStoredNegative);
}

export function decodeCacheValue<R, T extends string = string>(
  text: string,
  options: DefineCacheOptions<T, R> = {},
): CacheReadResult<R> {
  const prefixed = decodePrefixedPayload<R>(text);
  if (prefixed) return prefixed;

  const parsed = JSON.parse(text) as unknown;
  if (options.negative && isStoredNegative(parsed)) {
    return { hit: true, value: undefined, stale: false };
  }

  if (!options.stale || !isStoredValue(parsed)) {
    return { hit: true, value: parsed as R, stale: false };
  }

  const freshUntil = typeof parsed.freshUntil === 'number' ? parsed.freshUntil : undefined;
  return {
    hit: true,
    value: parsed.data as R,
    stale: freshUntil !== undefined && Date.now() > freshUntil,
  };
}
