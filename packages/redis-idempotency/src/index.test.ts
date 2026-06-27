import { describe, expect, it, vi } from 'vitest';
import { Pipeline, PipelineContext } from '@hile/model';
import {
  IdempotencyOwnershipLostError,
  IdempotencyConflictError,
  IdempotencyPayloadMismatchError,
  IdempotencyRetryableError,
  idempotent,
  stableHash,
  withIdempotency,
  type RedisLike,
} from './index';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class MemoryRedis implements RedisLike {
  private readonly values = new Map<string, string>();

  public async get(key: string) {
    return this.values.get(key) ?? null;
  }

  public async set(key: string, value: string, _px: 'PX', _ttl: number) {
    this.values.set(key, value);
    return 'OK';
  }

  public async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }

  public async eval(script: string, _keyCount: number, key: string, ...args: Array<string | number>) {
    if (script.includes('ACQUIRE_OR_READ')) {
      const [token, fingerprint, inFlight, lockTtl] = args as [string, string, string, number];
      const raw = this.values.get(key);
      if (!raw) {
        await this.set(key, inFlight, 'PX', lockTtl);
        return ['ACQUIRED'];
      }
      const value = JSON.parse(raw);
      if (value.fingerprint !== fingerprint) return ['MISMATCH'];
      if (value.state === 'DONE') return ['CACHED', raw];
      return ['IN_FLIGHT'];
    }

    if (script.includes('COMMIT_IF_OWNER')) {
      const [token, done, resultTtl] = args as [string, string, number];
      const raw = this.values.get(key);
      if (!raw) return 0;
      const value = JSON.parse(raw);
      if (value.state === 'IN_FLIGHT' && value.token === token) {
        await this.set(key, done, 'PX', resultTtl);
        return 1;
      }
      return 0;
    }

    if (script.includes('RELEASE_IF_OWNER')) {
      const [token] = args as [string];
      const raw = this.values.get(key);
      if (!raw) return 0;
      const value = JSON.parse(raw);
      if (value.state === 'IN_FLIGHT' && value.token === token) {
        return this.del(key);
      }
      return 0;
    }

    throw new Error(`unknown script: ${script}`);
  }
}

describe('stableHash', () => {
  it('hashes object keys in stable order', () => {
    expect(stableHash({ b: 2, a: 1 })).toBe(stableHash({ a: 1, b: 2 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });

  it('rejects unsupported object types instead of silently hashing them as empty objects', () => {
    expect(() => stableHash(new Map([['a', 1]]))).toThrow(TypeError);
    expect(() => stableHash(new Set([1]))).toThrow(TypeError);
    expect(() => stableHash(/abc/)).toThrow(TypeError);
    expect(stableHash({})).not.toBe(stableHash({ value: {} }));
  });

  it('rejects circular values with a useful error', () => {
    const value: Record<string, unknown> = {};
    value.self = value;

    expect(() => stableHash(value)).toThrow(/circular/i);
  });

  it('rejects sparse arrays instead of hashing holes as missing values', () => {
    const value = new Array(1);

    expect(() => stableHash(value)).toThrow(/sparse/i);
  });
});

describe('withIdempotency', () => {
  it('coalesces concurrent calls for the same key and fingerprint', async () => {
    const redis = new MemoryRedis();
    const gate = createDeferred<{ ok: true }>();
    const fn = vi.fn(() => gate.promise);

    const first = withIdempotency(redis, 'idem:test:concurrent', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      wait: 1000,
      fingerprint: 'same',
    });
    const second = withIdempotency(redis, 'idem:test:concurrent', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      wait: 1000,
      fingerprint: 'same',
    });

    await sleep(30);
    gate.resolve({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns cached results without rerunning the function', async () => {
    const redis = new MemoryRedis();
    const fn = vi.fn(async () => ({ value: 'created' }));

    await expect(withIdempotency(redis, 'idem:test:cache', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).resolves.toEqual({ value: 'created' });
    await expect(withIdempotency(redis, 'idem:test:cache', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).resolves.toEqual({ value: 'created' });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rejects the same key with a different fingerprint', async () => {
    const redis = new MemoryRedis();
    await withIdempotency(redis, 'idem:test:mismatch', async () => ({ ok: true }), {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'a',
    });

    await expect(withIdempotency(redis, 'idem:test:mismatch', async () => ({ ok: false }), {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'b',
    })).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
  });

  it('releases an in-flight key when the function fails', async () => {
    const redis = new MemoryRedis();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true });

    await expect(withIdempotency(redis, 'idem:test:retry', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).rejects.toThrow('boom');
    await expect(withIdempotency(redis, 'idem:test:retry', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).resolves.toEqual({ ok: true });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws ownership lost when the owner no longer owns the key at commit time', async () => {
    const redis = new MemoryRedis();

    await expect(withIdempotency(redis, 'idem:test:lost', async () => {
      await redis.del('idem:test:lost');
      return { ok: true };
    }, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).rejects.toBeInstanceOf(IdempotencyOwnershipLostError);
  });

  it('signals retryable errors to waiters when the owner releases the key after failure', async () => {
    const redis = new MemoryRedis();
    const gate = createDeferred<void>();
    const first = withIdempotency(redis, 'idem:test:waiter-retry', async () => {
      await gate.promise;
      throw new Error('owner failed');
    }, {
      lockTtl: 1000,
      resultTtl: 1000,
      wait: 1000,
      fingerprint: 'same',
    });

    const second = withIdempotency(redis, 'idem:test:waiter-retry', async () => ({ ok: true }), {
      lockTtl: 1000,
      resultTtl: 1000,
      wait: 1000,
      fingerprint: 'same',
    });

    await sleep(30);
    gate.resolve();

    await expect(first).rejects.toThrow('owner failed');
    await expect(second).rejects.toBeInstanceOf(IdempotencyRetryableError);
  });

  it('rejects lossy default result serialization instead of caching a corrupted value', async () => {
    const redis = new MemoryRedis();
    const retry = vi.fn(async () => ({ ok: true }));

    await expect(withIdempotency(redis, 'idem:test:lossy-result', async () => ({
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }), {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
    })).rejects.toThrow(/JSON-serializable/);

    await expect(withIdempotency(redis, 'idem:test:lossy-result', retry, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
      onConflict: 'reject',
    })).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(retry).not.toHaveBeenCalled();
  });

  it('uses a custom result codec for non-JSON result types', async () => {
    const redis = new MemoryRedis();
    const fn = vi.fn(async () => ({
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    }));
    const resultCodec = {
      serialize: (value: { createdAt: Date }) => JSON.stringify({ createdAt: value.createdAt.toISOString() }),
      deserialize: (value: string) => {
        const parsed = JSON.parse(value) as { createdAt: string };
        return { createdAt: new Date(parsed.createdAt) };
      },
    };

    const first = await withIdempotency(redis, 'idem:test:codec-result', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
      resultCodec,
    });
    const second = await withIdempotency(redis, 'idem:test:codec-result', fn, {
      lockTtl: 1000,
      resultTtl: 1000,
      fingerprint: 'same',
      resultCodec,
    });

    expect(first.createdAt).toBeInstanceOf(Date);
    expect(second.createdAt).toBeInstanceOf(Date);
    expect(second.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('preserves both the function failure and release failure', async () => {
    class ReleaseFailingRedis extends MemoryRedis {
      public override async eval(script: string, keyCount: number, key: string, ...args: Array<string | number>) {
        if (script.includes('RELEASE_IF_OWNER')) {
          throw new Error('release failed');
        }
        return super.eval(script, keyCount, key, ...args);
      }
    }
    const redis = new ReleaseFailingRedis();

    try {
      await withIdempotency(redis, 'idem:test:release-failed', async () => {
        throw new Error('business failed');
      }, {
        lockTtl: 1000,
        resultTtl: 1000,
        fingerprint: 'same',
      });
      throw new Error('expected withIdempotency to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors.map((error) => (error as Error).message)).toEqual([
        'business failed',
        'release failed',
      ]);
    }
  });
});

describe('idempotent middleware', () => {
  it('caches ctx.state.result and short-circuits later pipeline dispatches', async () => {
    const redis = new MemoryRedis();
    const main = vi.fn(async (input: { tenantId: string; requestId: string }) => ({
      charged: true,
      requestId: input.requestId,
    }));
    const pipeline = new Pipeline<{ tenantId: string; requestId: string }>();
    pipeline.use(idempotent({
      redis,
      key: (input) => `idem:test:debit:${input.tenantId}:${input.requestId}`,
      fingerprint: stableHash,
      lockTtl: 1000,
      resultTtl: 1000,
    }));
    pipeline.use(async (ctx) => {
      ctx.state.result = await main(ctx.args);
    });

    const first = new PipelineContext({ tenantId: 't1', requestId: 'r1' });
    await pipeline.dispatch(first);
    expect(first.state.result).toEqual({ charged: true, requestId: 'r1' });

    const second = new PipelineContext({ tenantId: 't1', requestId: 'r1' });
    await pipeline.dispatch(second);
    expect(second.state.result).toEqual({ charged: true, requestId: 'r1' });

    expect(main).toHaveBeenCalledTimes(1);
  });
});
