import {
  LockConflictError,
  LockOwnershipLostError,
  LockTimeoutError,
  RedisLock,
  type RedisLockLease,
} from '@hile/redis-lock';
import {
  IdempotencyConflictError,
  IdempotencyOwnershipLostError,
  IdempotencyPayloadMismatchError,
  IdempotencyRetryableError,
  IdempotencyTimeoutError,
} from './errors';
import { RedisIdempotencyStore } from './store';
import type {
  IdempotencyOptions,
  IdempotencyResultCodec,
  RedisLike,
} from './types';

type ResolvedIdempotencyOptions<T> = IdempotencyOptions<T> & {
  wait: number;
  onConflict: 'wait' | 'reject';
  pollInterval: number;
  maxPollInterval: number;
};

interface RunContext<T> {
  key: string;
  lockKey: string;
  fn: () => Promise<T>;
  options: ResolvedIdempotencyOptions<T>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function resolveOptions<T>(options: IdempotencyOptions<T>): ResolvedIdempotencyOptions<T> {
  assertPositiveInteger(options.lockTtl, 'lockTtl');
  assertPositiveInteger(options.resultTtl, 'resultTtl');
  if (!options.fingerprint) throw new TypeError('fingerprint is required');

  const resolved = {
    ...options,
    wait: options.wait ?? options.lockTtl,
    onConflict: options.onConflict ?? 'wait',
    pollInterval: options.pollInterval ?? 20,
    maxPollInterval: options.maxPollInterval ?? 500,
  };
  assertPositiveInteger(resolved.wait, 'wait');
  assertPositiveInteger(resolved.pollInterval, 'pollInterval');
  assertPositiveInteger(resolved.maxPollInterval, 'maxPollInterval');
  return resolved;
}

export interface RedisIdempotencyDependencies {
  locks?: RedisLock;
}

export class RedisIdempotency {
  private readonly locks: RedisLock;
  private readonly store: RedisIdempotencyStore;

  constructor(
    redis: RedisLike,
    dependencies: RedisIdempotencyDependencies = {},
  ) {
    this.locks = dependencies.locks ?? new RedisLock(redis);
    this.store = new RedisIdempotencyStore(redis);
  }

  public async run<T>(
    key: string,
    fn: () => Promise<T>,
    options: IdempotencyOptions<T>,
  ): Promise<T> {
    const resolved = resolveOptions(options);
    const context: RunContext<T> = {
      key,
      lockKey: this.makeLockKey(key),
      fn,
      options: resolved,
    };

    const existing = await this.store.read<T>(key, resolved.fingerprint, resolved.resultCodec);
    if (existing.type === 'cached') return existing.data;
    if (existing.type === 'mismatch') throw new IdempotencyPayloadMismatchError(key);
    if (existing.type === 'in-flight') return this.handleInFlight(context);

    try {
      return await this.locks.withLock(
        context.lockKey,
        { ttl: resolved.lockTtl, wait: 0 },
        lease => this.runAsOwner(context, lease, false),
      );
    } catch (err) {
      if (!(err instanceof LockConflictError)) throw this.mapLockError(key, err);
      if (resolved.onConflict === 'reject') throw new IdempotencyConflictError(key);
    }

    try {
      return await this.locks.withLock(
        context.lockKey,
        {
          ttl: resolved.lockTtl,
          wait: resolved.wait,
          pollInterval: resolved.pollInterval,
          maxPollInterval: resolved.maxPollInterval,
        },
        lease => this.runAsOwner(context, lease, true),
      );
    } catch (err) {
      throw this.mapLockError(key, err);
    }
  }

  private makeLockKey(key: string): string {
    return `${key}:lock`;
  }

  private async handleInFlight<T>(context: RunContext<T>): Promise<T> {
    if (context.options.onConflict === 'reject') {
      throw new IdempotencyConflictError(context.key);
    }
    return this.waitForResult(context);
  }

  private async runAsOwner<T>(
    context: RunContext<T>,
    lease: RedisLockLease,
    contended: boolean,
  ): Promise<T> {
    const current = await this.store.read<T>(
      context.key,
      context.options.fingerprint,
      context.options.resultCodec,
    );
    if (current.type === 'cached') return current.data;
    if (current.type === 'mismatch') throw new IdempotencyPayloadMismatchError(context.key);
    if (current.type === 'in-flight') return this.handleInFlight(context);
    if (contended) throw new IdempotencyRetryableError(context.key);

    await this.store.markInFlight(
      context.key,
      lease.token,
      context.options.fingerprint,
      context.options.lockTtl,
    );

    let result: T;
    try {
      result = await context.fn();
    } catch (err) {
      let cleared: boolean;
      try {
        cleared = await this.store.clearInFlightIfLockOwner(context.key, lease.key, lease.token);
      } catch (releaseErr) {
        throw new AggregateError(
          [err, releaseErr],
          'Idempotency operation failed and clearing the in-flight key also failed',
        );
      }
      if (!cleared) {
        throw new AggregateError(
          [err, new IdempotencyOwnershipLostError(context.key)],
          'Idempotency operation failed and clearing the in-flight key also failed',
        );
      }
      throw err;
    }

    const committed = await this.store.commitDoneIfLockOwner(
      context.key,
      lease.key,
      lease.token,
      context.options.fingerprint,
      result,
      context.options.resultTtl,
      context.options.resultCodec,
    );
    if (!committed) throw new IdempotencyOwnershipLostError(context.key);
    return result;
  }

  private async waitForResult<T>(context: RunContext<T>): Promise<T> {
    const deadline = Date.now() + context.options.wait;
    let delay = context.options.pollInterval;

    while (Date.now() < deadline) {
      const state = await this.store.read<T>(
        context.key,
        context.options.fingerprint,
        context.options.resultCodec,
      );
      if (state.type === 'empty') throw new IdempotencyRetryableError(context.key);
      if (state.type === 'mismatch') throw new IdempotencyPayloadMismatchError(context.key);
      if (state.type === 'cached') return state.data;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, context.options.maxPollInterval);
    }

    throw new IdempotencyTimeoutError(context.key);
  }

  private mapLockError(key: string, err: unknown): unknown {
    if (err instanceof LockConflictError) return new IdempotencyConflictError(key);
    if (err instanceof LockTimeoutError) return new IdempotencyTimeoutError(key);
    if (err instanceof LockOwnershipLostError) return new IdempotencyOwnershipLostError(key);
    return err;
  }
}

export type RedisIdempotencyResultCodec<T = unknown> = IdempotencyResultCodec<T>;
