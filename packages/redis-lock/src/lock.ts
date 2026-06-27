import { randomUUID } from 'node:crypto';
import {
  LockConflictError,
  LockOwnershipLostError,
  LockRenewalError,
  LockTimeoutError,
} from './errors';
import {
  ASSERT_LOCK_OWNER,
  RELEASE_LOCK_IF_OWNER,
  RENEW_LOCK_IF_OWNER,
  TRY_ACQUIRE_LOCK,
} from './scripts';
import type {
  RedisLockDefaults,
  RedisLockHandle,
  RedisLockLike,
  ResolvedWithLockOptions,
  TryLockInputOptions,
  TryLockOptions,
  WithLockOptions,
} from './types';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function normalizeEvalArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Redis lock script result');
  }
  return value;
}

function defaultFencingKey(key: string): string {
  return `${key}:fencing`;
}

function resolveFencingKey(key: string, fencing: TryLockOptions['fencing']): string {
  if (typeof fencing === 'object' && fencing.key) return fencing.key;
  return defaultFencingKey(key);
}

async function releaseIfOwner(redis: RedisLockLike, key: string, token: string): Promise<boolean> {
  return await redis.eval(RELEASE_LOCK_IF_OWNER, 1, key, token) === 1;
}

async function renewIfOwner(redis: RedisLockLike, key: string, token: string, ttl: number): Promise<boolean> {
  return await redis.eval(RENEW_LOCK_IF_OWNER, 1, key, token, ttl) === 1;
}

async function assertOwner(redis: RedisLockLike, key: string, token: string): Promise<void> {
  const owned = await redis.eval(ASSERT_LOCK_OWNER, 1, key, token);
  if (owned !== 1) throw new LockOwnershipLostError(key);
}

export class RedisLockLease implements RedisLockHandle {
  constructor(
    private readonly redis: RedisLockLike,
    public readonly key: string,
    public readonly token: string,
    private readonly ttl: number,
    public readonly fencingToken?: number,
  ) { }

  public async renew(nextTtl = this.ttl): Promise<void> {
    assertPositiveInteger(nextTtl, 'ttl');
    const renewed = await renewIfOwner(this.redis, this.key, this.token, nextTtl);
    if (!renewed) throw new LockRenewalError(this.key);
  }

  public async release(): Promise<boolean> {
    return releaseIfOwner(this.redis, this.key, this.token);
  }

  public async assertOwner(): Promise<void> {
    await assertOwner(this.redis, this.key, this.token);
  }
}

async function acquireLock(
  redis: RedisLockLike,
  key: string,
  options: TryLockOptions,
): Promise<RedisLockLease | undefined> {
  assertPositiveInteger(options.ttl, 'ttl');
  const token = options.token ?? randomUUID();
  const useFencing = !!options.fencing;
  const fencingKey = useFencing ? resolveFencingKey(key, options.fencing) : '';
  const result = normalizeEvalArray(
    useFencing
      ? await redis.eval(TRY_ACQUIRE_LOCK, 2, key, fencingKey, token, options.ttl, '1')
      : await redis.eval(TRY_ACQUIRE_LOCK, 1, key, token, options.ttl, '0'),
  );

  if (result[0] === 'LOCKED') return undefined;
  if (result[0] !== 'ACQUIRED') {
    throw new Error(`Unknown Redis lock script status: ${String(result[0])}`);
  }

  const rawFencingToken = result[1];
  const fencingToken = rawFencingToken === undefined ? undefined : Number(rawFencingToken);
  return new RedisLockLease(redis, key, token, options.ttl, fencingToken);
}

async function acquireWithWait(
  redis: RedisLockLike,
  key: string,
  options: ResolvedWithLockOptions,
): Promise<RedisLockLease> {
  const wait = options.wait ?? 0;
  assertPositiveInteger(options.ttl, 'ttl');
  if (wait < 0 || !Number.isFinite(wait) || Math.trunc(wait) !== wait) {
    throw new TypeError('wait must be a non-negative integer');
  }
  const pollInterval = options.pollInterval ?? 20;
  const maxPollInterval = options.maxPollInterval ?? 500;
  assertPositiveInteger(pollInterval, 'pollInterval');
  assertPositiveInteger(maxPollInterval, 'maxPollInterval');

  const first = await acquireLock(redis, key, options);
  if (first) return first;
  if (wait === 0) throw new LockConflictError(key);

  const deadline = Date.now() + wait;
  let delay = pollInterval;

  while (Date.now() < deadline) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    const lock = await acquireLock(redis, key, options);
    if (lock) return lock;
    delay = Math.min(delay * 2, maxPollInterval);
  }

  throw new LockTimeoutError(key);
}

function getRenewInterval(options: ResolvedWithLockOptions): number | undefined {
  if (!options.renew) return undefined;
  if (typeof options.renew === 'object' && options.renew.interval !== undefined) {
    assertPositiveInteger(options.renew.interval, 'renew.interval');
    return options.renew.interval;
  }
  return Math.max(1, Math.floor(options.ttl / 2));
}

async function releaseAfterFailure(lock: RedisLockLease, err: unknown, message: string): Promise<never> {
  let released: boolean;
  try {
    released = await lock.release();
  } catch (releaseErr) {
    throw new AggregateError([err, releaseErr], message);
  }
  if (!released && !(err instanceof LockOwnershipLostError)) {
    throw new AggregateError([err, new LockOwnershipLostError(lock.key)], message);
  }
  throw err;
}

async function runWithLock<T>(
  redis: RedisLockLike,
  key: string,
  options: ResolvedWithLockOptions,
  fn: (lock: RedisLockLease) => Promise<T>,
): Promise<T> {
  const lock = await acquireWithWait(redis, key, options);
  const renewInterval = getRenewInterval(options);
  let timer: ReturnType<typeof setInterval> | undefined;
  let renewalError: unknown;

  if (renewInterval !== undefined) {
    timer = setInterval(() => {
      void lock.renew().catch(err => {
        renewalError = err;
        if (timer) clearInterval(timer);
      });
    }, renewInterval);
    timer.unref?.();
  }

  let result!: T;
  try {
    result = await fn(lock);
  } catch (err) {
    if (timer) clearInterval(timer);
    await releaseAfterFailure(lock, err, 'Redis lock operation failed and releasing the lock also failed');
  }

  if (timer) clearInterval(timer);
  if (renewalError) {
    await releaseAfterFailure(lock, renewalError, 'Redis lock renewal failed and releasing the lock also failed');
  }
  try {
    await lock.assertOwner();
  } catch (err) {
    await releaseAfterFailure(lock, err, 'Redis lock ownership check failed and releasing the lock also failed');
  }
  const released = await lock.release();
  if (!released) throw new LockOwnershipLostError(lock.key);
  return result;
}

export class RedisLock {
  constructor(
    private readonly redis: RedisLockLike,
    private readonly defaults: RedisLockDefaults = {},
  ) { }

  public async tryLock(key: string, options: TryLockInputOptions = {}): Promise<RedisLockLease | undefined> {
    return acquireLock(this.redis, this.resolveKey(key), this.resolveTryOptions(options));
  }

  public async withLock<T>(key: string, fn: (lock: RedisLockLease) => Promise<T>): Promise<T>;
  public async withLock<T>(
    key: string,
    options: WithLockOptions,
    fn: (lock: RedisLockLease) => Promise<T>,
  ): Promise<T>;
  public async withLock<T>(
    key: string,
    optionsOrFn: WithLockOptions | ((lock: RedisLockLease) => Promise<T>),
    maybeFn?: (lock: RedisLockLease) => Promise<T>,
  ): Promise<T> {
    const options = typeof optionsOrFn === 'function' ? {} : optionsOrFn;
    const fn = typeof optionsOrFn === 'function' ? optionsOrFn : maybeFn;
    if (!fn) throw new TypeError('withLock callback is required');
    return runWithLock(this.redis, this.resolveKey(key), this.resolveWithOptions(options), fn);
  }

  public async assertOwner(key: string, token: string): Promise<void> {
    await assertOwner(this.redis, this.resolveKey(key), token);
  }

  private resolveKey(key: string): string {
    return `${this.defaults.prefix ?? ''}${key}`;
  }

  private resolveTryOptions(options: TryLockInputOptions): TryLockOptions {
    const ttl = options.ttl ?? this.defaults.defaultTtl;
    if (ttl === undefined) throw new TypeError('ttl is required');
    return {
      ttl,
      token: options.token,
      fencing: options.fencing ?? this.defaults.fencing,
    };
  }

  private resolveWithOptions(options: WithLockOptions): ResolvedWithLockOptions {
    return {
      ...this.resolveTryOptions(options),
      wait: options.wait ?? this.defaults.wait,
      pollInterval: options.pollInterval ?? this.defaults.pollInterval,
      maxPollInterval: options.maxPollInterval ?? this.defaults.maxPollInterval,
      renew: options.renew ?? this.defaults.renew,
    };
  }
}

export async function tryLock(
  redis: RedisLockLike,
  key: string,
  options: TryLockOptions,
): Promise<RedisLockLease | undefined> {
  return new RedisLock(redis).tryLock(key, options);
}

export async function withLock<T>(
  redis: RedisLockLike,
  key: string,
  options: ResolvedWithLockOptions,
  fn: (lock: RedisLockLease) => Promise<T>,
): Promise<T> {
  return new RedisLock(redis).withLock(key, options, fn);
}
