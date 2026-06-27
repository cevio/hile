import { describe, expect, it, vi } from 'vitest';
import {
  LockConflictError,
  LockOwnershipLostError,
  LockRenewalError,
  LockTimeoutError,
  RedisLock,
  RedisLockLease,
  tryLock,
  withLock,
  type RedisLockLike,
} from './index';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class MemoryRedis implements RedisLockLike {
  public readonly values = new Map<string, string>();
  public readonly counters = new Map<string, number>();

  public async eval(script: string, keyCount: number, ...keysAndArgs: Array<string | number>) {
    if (script.includes('TRY_ACQUIRE_LOCK')) {
      const [key] = keysAndArgs as [string];
      const maybeFenceKey = keyCount === 2 ? String(keysAndArgs[1]) : '';
      const token = String(keyCount === 2 ? keysAndArgs[2] : keysAndArgs[1]);
      const ttl = Number(keyCount === 2 ? keysAndArgs[3] : keysAndArgs[2]);
      const fencing = String(keyCount === 2 ? keysAndArgs[4] : keysAndArgs[3]);
      if (this.values.has(key)) return ['LOCKED'];
      this.values.set(key, token);
      if (ttl <= 0) throw new Error('ttl must be positive');
      if (fencing === '1') {
        const next = (this.counters.get(maybeFenceKey) ?? 0) + 1;
        this.counters.set(maybeFenceKey, next);
        return ['ACQUIRED', String(next)];
      }
      return ['ACQUIRED'];
    }

    if (script.includes('RELEASE_LOCK_IF_OWNER')) {
      const [key, token] = keysAndArgs as [string, string];
      if (this.values.get(key) !== token) return 0;
      this.values.delete(key);
      return 1;
    }

    if (script.includes('RENEW_LOCK_IF_OWNER')) {
      const [key, token, ttl] = keysAndArgs as [string, string, number];
      if (ttl <= 0) throw new Error('ttl must be positive');
      return this.values.get(key) === token ? 1 : 0;
    }

    if (script.includes('ASSERT_LOCK_OWNER')) {
      const [key, token] = keysAndArgs as [string, string];
      return this.values.get(key) === token ? 1 : 0;
    }

    throw new Error(`unknown script: ${script}`);
  }
}

describe('@hile/redis-lock', () => {
  it('RedisLock class applies prefix and default ttl', async () => {
    const redis = new MemoryRedis();
    const locks = new RedisLock(redis, {
      prefix: 'app:',
      defaultTtl: 1000,
    });

    const lease = await locks.tryLock('job:daily');

    expect(lease).toBeInstanceOf(RedisLockLease);
    expect(lease?.key).toBe('app:job:daily');
    expect(redis.values.get('app:job:daily')).toBe(lease?.token);
  });

  it('RedisLock class uses instance defaults for withLock', async () => {
    const redis = new MemoryRedis();
    const locks = new RedisLock(redis, {
      prefix: 'app:',
      defaultTtl: 1000,
      wait: 100,
      pollInterval: 10,
    });

    await expect(locks.withLock('job:daily', async lease => {
      expect(lease).toBeInstanceOf(RedisLockLease);
      expect(lease.key).toBe('app:job:daily');
      return 'done';
    })).resolves.toBe('done');

    expect(redis.values.has('app:job:daily')).toBe(false);
  });

  it('tryLock acquires a free key and blocks a second owner', async () => {
    const redis = new MemoryRedis();

    const first = await tryLock(redis, 'lock:test', { ttl: 1000 });
    const second = await tryLock(redis, 'lock:test', { ttl: 1000 });

    expect(first).not.toBeUndefined();
    expect(second).toBeUndefined();
    expect(redis.values.get('lock:test')).toBe(first?.token);
  });

  it('release only deletes the lock for the current owner', async () => {
    const redis = new MemoryRedis();
    const first = await tryLock(redis, 'lock:test', { ttl: 1000 });
    expect(first).toBeDefined();

    redis.values.set('lock:test', 'other-owner');
    await expect(first!.release()).resolves.toBe(false);
    expect(redis.values.get('lock:test')).toBe('other-owner');

    redis.values.set('lock:test', first!.token);
    await expect(first!.release()).resolves.toBe(true);
    expect(redis.values.has('lock:test')).toBe(false);
  });

  it('withLock returns the callback result and releases the key', async () => {
    const redis = new MemoryRedis();

    await expect(withLock(redis, 'lock:test', { ttl: 1000 }, async lock => {
      expect(lock.key).toBe('lock:test');
      expect(redis.values.get('lock:test')).toBe(lock.token);
      return { ok: true };
    })).resolves.toEqual({ ok: true });

    expect(redis.values.has('lock:test')).toBe(false);
  });

  it('withLock rejects immediately when the key is locked and no wait is configured', async () => {
    const redis = new MemoryRedis();
    await tryLock(redis, 'lock:test', { ttl: 1000 });

    await expect(withLock(redis, 'lock:test', { ttl: 1000 }, async () => 'never'))
      .rejects.toBeInstanceOf(LockConflictError);
  });

  it('withLock waits for a lock until another owner releases it', async () => {
    const redis = new MemoryRedis();
    const first = await tryLock(redis, 'lock:test', { ttl: 1000 });
    const fn = vi.fn(async () => 'acquired');

    const waiting = withLock(redis, 'lock:test', {
      ttl: 1000,
      wait: 500,
      pollInterval: 10,
      maxPollInterval: 20,
    }, fn);

    await sleep(30);
    expect(fn).not.toHaveBeenCalled();
    await first!.release();

    await expect(waiting).resolves.toBe('acquired');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withLock times out when the lock stays busy', async () => {
    const redis = new MemoryRedis();
    await tryLock(redis, 'lock:test', { ttl: 1000 });

    await expect(withLock(redis, 'lock:test', {
      ttl: 1000,
      wait: 30,
      pollInterval: 10,
    }, async () => 'never')).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('withLock reports ownership loss before returning a successful callback result', async () => {
    const redis = new MemoryRedis();

    await expect(withLock(redis, 'lock:test', { ttl: 1000 }, async () => {
      redis.values.delete('lock:test');
      return 'stale-success';
    })).rejects.toBeInstanceOf(LockOwnershipLostError);
  });

  it('withLock reports ownership loss if release no longer owns the lock', async () => {
    class ReleaseLostRedis extends MemoryRedis {
      private assertedOwner = false;

      public override async eval(script: string, keyCount: number, ...keysAndArgs: Array<string | number>) {
        if (script.includes('ASSERT_LOCK_OWNER')) {
          const result = await super.eval(script, keyCount, ...keysAndArgs);
          this.assertedOwner = result === 1;
          return result;
        }

        if (script.includes('RELEASE_LOCK_IF_OWNER') && this.assertedOwner) {
          const [key] = keysAndArgs as [string];
          this.values.delete(key);
          return 0;
        }

        return super.eval(script, keyCount, ...keysAndArgs);
      }
    }
    const redis = new ReleaseLostRedis();

    await expect(withLock(redis, 'lock:test', { ttl: 1000 }, async () => {
      return 'stale-success';
    })).rejects.toBeInstanceOf(LockOwnershipLostError);
  });

  it('withLock preserves ownership loss when releasing after the failure also fails', async () => {
    class ReleaseFailingRedis extends MemoryRedis {
      public override async eval(script: string, keyCount: number, ...keysAndArgs: Array<string | number>) {
        if (script.includes('RELEASE_LOCK_IF_OWNER')) {
          throw new Error('release failed');
        }
        return super.eval(script, keyCount, ...keysAndArgs);
      }
    }
    const redis = new ReleaseFailingRedis();

    try {
      await withLock(redis, 'lock:test', { ttl: 1000 }, async () => {
        redis.values.delete('lock:test');
        return 'stale-success';
      });
      throw new Error('expected withLock to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const errors = (err as AggregateError).errors;
      expect(errors[0]).toBeInstanceOf(LockOwnershipLostError);
      expect((errors[1] as Error).message).toBe('release failed');
    }
  });

  it('withLock preserves callback failure when release no longer owns the lock', async () => {
    class ReleaseLostRedis extends MemoryRedis {
      public override async eval(script: string, keyCount: number, ...keysAndArgs: Array<string | number>) {
        if (script.includes('RELEASE_LOCK_IF_OWNER')) {
          const [key] = keysAndArgs as [string];
          this.values.delete(key);
          return 0;
        }
        return super.eval(script, keyCount, ...keysAndArgs);
      }
    }
    const redis = new ReleaseLostRedis();

    try {
      await withLock(redis, 'lock:test', { ttl: 1000 }, async () => {
        throw new Error('business failed');
      });
      throw new Error('expected withLock to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      const errors = (err as AggregateError).errors;
      expect((errors[0] as Error).message).toBe('business failed');
      expect(errors[1]).toBeInstanceOf(LockOwnershipLostError);
    }
  });

  it('renew throws when the caller no longer owns the lock', async () => {
    const redis = new MemoryRedis();
    const lock = await tryLock(redis, 'lock:test', { ttl: 1000 });
    expect(lock).toBeDefined();

    redis.values.set('lock:test', 'other-owner');

    await expect(lock!.renew()).rejects.toBeInstanceOf(LockRenewalError);
  });

  it('fencing tokens increase across successful acquisitions', async () => {
    const redis = new MemoryRedis();
    const first = await tryLock(redis, 'lock:test', { ttl: 1000, fencing: true });
    await first!.release();
    const second = await tryLock(redis, 'lock:test', { ttl: 1000, fencing: true });

    expect(first?.fencingToken).toBe(1);
    expect(second?.fencingToken).toBe(2);
  });
});
