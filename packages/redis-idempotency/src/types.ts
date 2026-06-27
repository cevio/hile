export type RedisEvalResult = unknown;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type StoredIdempotencyResult =
  | { encoding: 'undefined' }
  | { encoding: 'json'; value: JsonValue }
  | { encoding: 'custom'; value: string };

export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, px: 'PX', ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  eval(script: string, numberOfKeys: number, key: string, ...args: Array<string | number>): Promise<RedisEvalResult>;
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

export interface IdempotentMiddlewareOptions<TInput extends object = Record<string, unknown>>
  extends Omit<IdempotencyOptions, 'fingerprint'> {
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
