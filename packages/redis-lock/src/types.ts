export type RedisEvalResult = unknown;

export interface RedisLockLike {
  eval(script: string, numberOfKeys: number, ...keysAndArgs: Array<string | number>): Promise<RedisEvalResult>;
}

export interface TryLockOptions {
  ttl: number;
  token?: string;
  fencing?: boolean | {
    key?: string;
  };
}

export type TryLockInputOptions = Partial<TryLockOptions>;

export interface WithLockOptions extends TryLockInputOptions {
  wait?: number;
  pollInterval?: number;
  maxPollInterval?: number;
  renew?: boolean | {
    interval?: number;
  };
}

export type ResolvedWithLockOptions = WithLockOptions & {
  ttl: number;
};

export interface RedisLockDefaults extends Omit<WithLockOptions, 'ttl' | 'token'> {
  prefix?: string;
  defaultTtl?: number;
}

export interface RedisLockHandle {
  readonly key: string;
  readonly token: string;
  readonly fencingToken?: number;
  renew(ttl?: number): Promise<void>;
  release(): Promise<boolean>;
  assertOwner(): Promise<void>;
}
