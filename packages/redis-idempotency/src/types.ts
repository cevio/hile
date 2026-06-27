import type { RedisLockLike } from '@hile/redis-lock';

export type RedisEvalResult = unknown;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type StoredIdempotencyResult =
  | { encoding: 'undefined' }
  | { encoding: 'json'; value: JsonValue }
  | { encoding: 'custom'; value: string };

export interface RedisLike extends RedisLockLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

export interface IdempotencyResultCodec<T = unknown> {
  serialize(value: T): string;
  deserialize(value: string): T;
}

export interface IdempotencyOptions<T = unknown> {
  lockTtl: number;
  resultTtl: number;
  fingerprint: string;
  wait?: number;
  onConflict?: 'wait' | 'reject';
  pollInterval?: number;
  maxPollInterval?: number;
  resultCodec?: IdempotencyResultCodec<T>;
}

export interface IdempotentMiddlewareOptions<
  TInput extends object = Record<string, unknown>,
  TResult = unknown,
> extends Omit<IdempotencyOptions<TResult>, 'fingerprint'> {
  redis: RedisLike;
  key: (input: TInput) => string;
  fingerprint: string | ((input: TInput) => string);
}

export type IdempotencyState<T = unknown> =
  | {
    state: 'IN_FLIGHT';
    token: string;
    fingerprint: string;
    startedAt: number;
  }
  | {
    state: 'DONE';
    fingerprint: string;
    data: StoredIdempotencyResult;
    finishedAt: number;
  };
