import { Pipeline, PipelineContext } from '@hile/model';
import { describe, expect, it, vi } from 'vitest';
import {
  RateLimitExceededError,
  RedisRateLimiter,
  defineLimit,
  rateLimitHttp,
  rateLimitModel,
  type RedisRateLimitLike,
} from './index';

type Entry = {
  count: number;
  expiresAt: number;
};

type BucketEntry = {
  tokens: number;
  updatedAt: number;
  expiresAt: number;
};

class MemoryRedis implements RedisRateLimitLike {
  public readonly values = new Map<string, Entry>();
  public readonly sliding = new Map<string, number[]>();
  public readonly buckets = new Map<string, BucketEntry>();

  public async eval(script: string, _keyCount: number, ...keysAndArgs: Array<string | number>) {
    if (script.includes('FIXED_WINDOW_RATE_LIMIT')) {
      return this.evalFixedWindow(keysAndArgs);
    }

    if (script.includes('SLIDING_WINDOW_RATE_LIMIT')) {
      return this.evalSlidingWindow(keysAndArgs);
    }

    if (script.includes('TOKEN_BUCKET_RATE_LIMIT')) {
      return this.evalTokenBucket(keysAndArgs);
    }

    throw new Error(`unknown script: ${script}`);
  }

  private evalFixedWindow(keysAndArgs: Array<string | number>) {
    const [key, nowRaw, limitRaw, windowRaw, dryRunRaw] = keysAndArgs as [string, number, number, number, string];
    const now = Number(nowRaw);
    const limit = Number(limitRaw);
    const window = Number(windowRaw);
    const dryRun = dryRunRaw === '1';
    const entry = this.read(key, now);
    const nextCount = (entry?.count ?? 0) + 1;
    const allowed = nextCount <= limit;
    const resetAt = entry?.expiresAt ?? now + window;
    const retryAfter = allowed ? 0 : Math.max(0, resetAt - now);

    if (!dryRun) {
      this.values.set(key, {
        count: nextCount,
        expiresAt: resetAt,
      });
    }

    return [
      allowed ? 1 : 0,
      Math.max(0, limit - nextCount),
      resetAt,
      retryAfter,
    ];
  }

  private evalSlidingWindow(keysAndArgs: Array<string | number>) {
    const [key, nowRaw, limitRaw, windowRaw, dryRunRaw] = keysAndArgs as [string, number, number, number, string];
    const now = Number(nowRaw);
    const limit = Number(limitRaw);
    const window = Number(windowRaw);
    const dryRun = dryRunRaw === '1';
    const cutoff = now - window;
    const current = (this.sliding.get(key) ?? []).filter(score => score > cutoff);
    const allowed = current.length < limit;
    const observed = allowed ? [...current, now] : current;
    const resetAt = observed.length === 0 ? now + window : Math.min(...observed) + window;
    const retryAfter = allowed ? 0 : Math.max(0, resetAt - now);

    if (!dryRun) {
      this.sliding.set(key, observed);
    }

    return [
      allowed ? 1 : 0,
      Math.max(0, limit - observed.length),
      resetAt,
      retryAfter,
    ];
  }

  private evalTokenBucket(keysAndArgs: Array<string | number>) {
    const [key, nowRaw, limitRaw, windowRaw, dryRunRaw] = keysAndArgs as [string, number, number, number, string];
    const now = Number(nowRaw);
    const limit = Number(limitRaw);
    const window = Number(windowRaw);
    const dryRun = dryRunRaw === '1';
    const entry = this.readBucket(key, now);
    const previousTokens = entry?.tokens ?? limit;
    const previousUpdatedAt = entry?.updatedAt ?? now;
    const effectiveNow = Math.max(now, previousUpdatedAt);
    const elapsed = effectiveNow - previousUpdatedAt;
    const refill = elapsed * limit / window;
    const available = Math.min(limit, previousTokens + refill);
    const allowed = available >= 1;
    const nextTokens = allowed ? available - 1 : available;
    const nextTokenAt = effectiveNow + Math.ceil((1 - available) * window / limit);
    const fullAt = effectiveNow + Math.ceil((limit - nextTokens) * window / limit);
    const resetAt = allowed ? fullAt : nextTokenAt;
    const retryAfter = allowed ? 0 : Math.max(0, resetAt - now);

    if (!dryRun) {
      this.buckets.set(key, {
        tokens: nextTokens,
        updatedAt: effectiveNow,
        expiresAt: fullAt,
      });
    }

    return [
      allowed ? 1 : 0,
      Math.floor(nextTokens),
      resetAt,
      retryAfter,
    ];
  }

  private read(key: string, now: number): Entry | undefined {
    const entry = this.values.get(key);
    if (!entry) return;
    if (entry.expiresAt <= now) {
      this.values.delete(key);
      return;
    }
    return entry;
  }

  private readBucket(key: string, now: number): BucketEntry | undefined {
    const entry = this.buckets.get(key);
    if (!entry) return;
    if (entry.expiresAt <= now) {
      this.buckets.delete(key);
      return;
    }
    return entry;
  }
}

describe('@hile/redis-rate-limit', () => {
  it('consumes a fixed-window limit with typed key parameters and a prefix', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis, { prefix: 'app:' });
    const loginLimit = defineLimit('rl:login:{ip:string}', {
      algorithm: 'fixed-window',
      limit: 2,
      window: 60_000,
    });

    const first = await limiter.consume(loginLimit, { ip: '127.0.0.1' }, { now: 1_000 });
    const second = await limiter.consume(loginLimit, { ip: '127.0.0.1' }, { now: 2_000 });

    expect(first).toEqual({
      allowed: true,
      algorithm: 'fixed-window',
      key: 'app:rl:login:127.0.0.1',
      limit: 2,
      remaining: 1,
      resetAt: 61_000,
      retryAfter: 0,
      dryRun: false,
    });
    expect(second).toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 61_000,
      retryAfter: 0,
    });
  });

  it('rejects requests after the fixed-window quota is consumed', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:sms:{phone:string}', {
      algorithm: 'fixed-window',
      limit: 1,
      window: 10_000,
    });

    await limiter.consume(limit, { phone: '13800000000' }, { now: 5_000 });
    const exceeded = await limiter.consume(limit, { phone: '13800000000' }, { now: 7_000 });

    expect(exceeded).toMatchObject({
      allowed: false,
      key: 'rl:sms:13800000000',
      remaining: 0,
      resetAt: 15_000,
      retryAfter: 8_000,
    });
  });

  it('dry-runs without mutating the Redis counter', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:tenant:{tenantId:string}', {
      algorithm: 'fixed-window',
      limit: 1,
      window: 1_000,
    });

    const dryRun = await limiter.consume(limit, { tenantId: 'a' }, { dryRun: true, now: 0 });
    const actual = await limiter.consume(limit, { tenantId: 'a' }, { now: 0 });
    const observedExceeded = await limiter.consume(limit, { tenantId: 'a' }, { dryRun: true, now: 1 });
    const exceeded = await limiter.consume(limit, { tenantId: 'a' }, { now: 1 });

    expect(dryRun).toMatchObject({ allowed: true, dryRun: true, remaining: 0 });
    expect(actual).toMatchObject({ allowed: true, dryRun: false, remaining: 0 });
    expect(observedExceeded).toMatchObject({ allowed: false, dryRun: true, remaining: 0 });
    expect(exceeded).toMatchObject({ allowed: false, dryRun: false, remaining: 0 });
    expect(redis.values.get('rl:tenant:a')?.count).toBe(2);
  });

  it('sliding-window expires individual hits instead of resetting the whole bucket at once', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:search:{tenantId:string}', {
      algorithm: 'sliding-window',
      limit: 2,
      window: 10_000,
    });

    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 }))
      .resolves.toMatchObject({ allowed: true, algorithm: 'sliding-window', remaining: 1, resetAt: 10_000 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, resetAt: 10_000 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 2_000 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0, retryAfter: 8_000, resetAt: 10_000 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 10_001 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, retryAfter: 0, resetAt: 11_000 });
  });

  it('sliding-window dry-runs without reserving a hit', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:preview:{tenantId:string}', {
      algorithm: 'sliding-window',
      limit: 1,
      window: 1_000,
    });

    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { dryRun: true, now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: true, remaining: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: false, remaining: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0, retryAfter: 999 });
  });

  it('token-bucket refills gradually over the configured window', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:email:{tenantId:string}', {
      algorithm: 'token-bucket',
      limit: 4,
      window: 4_000,
    });

    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 }))
      .resolves.toMatchObject({ allowed: true, algorithm: 'token-bucket', remaining: 3 });
    await limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 });
    await limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, resetAt: 4_000 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 500 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0, retryAfter: 500, resetAt: 1_000 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, retryAfter: 0, resetAt: 5_000 });
  });

  it('token-bucket dry-runs without consuming a token', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:send:{tenantId:string}', {
      algorithm: 'token-bucket',
      limit: 1,
      window: 1_000,
    });

    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { dryRun: true, now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: true, remaining: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: false, remaining: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1 }))
      .resolves.toMatchObject({ allowed: false, retryAfter: 999 });
  });

  it('token-bucket does not move its refill clock backwards', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:clock:{tenantId:string}', {
      algorithm: 'token-bucket',
      limit: 1,
      window: 1_000,
    });

    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 500 }))
      .resolves.toMatchObject({ allowed: false, retryAfter: 1_500 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 1_500 }))
      .resolves.toMatchObject({ allowed: false, retryAfter: 500 });
    await expect(limiter.consume(limit, { tenantId: 'tenant-a' }, { now: 2_000 }))
      .resolves.toMatchObject({ allowed: true, retryAfter: 0 });
  });

  it('rejects unsupported algorithms at consume time when a limit is manually constructed', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);

    await expect(limiter.consume({
      key: 'rl:bad:{id:string}',
      algorithm: 'unknown' as any,
      limit: 1,
      window: 1_000,
    }, { id: 'a' })).rejects.toThrow('Unsupported rate limit algorithm: unknown');
  });

  it('HTTP middleware sets rate-limit headers and returns 429 when exceeded', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:http:{ip:string}', {
      algorithm: 'fixed-window',
      limit: 1,
      window: 60_000,
    });
    const middleware = rateLimitHttp(limit, {
      limiter,
      key: ctx => ({ ip: ctx.ip }),
      now: 1_000,
    });
    const next = vi.fn(async (ctx: TestHttpContext) => {
      ctx.body = { ok: true };
    });

    const allowed = createHttpContext('127.0.0.1');
    await middleware(allowed, () => next(allowed));
    expect(next).toHaveBeenCalledTimes(1);
    expect(allowed.body).toEqual({ ok: true });
    expect(allowed.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(allowed.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(allowed.headers.get('X-RateLimit-Reset')).toBe('61');

    const exceeded = createHttpContext('127.0.0.1');
    await middleware(exceeded, () => next(exceeded));
    expect(next).toHaveBeenCalledTimes(1);
    expect(exceeded.status).toBe(429);
    expect(exceeded.headers.get('Retry-After')).toBe('60');
    expect(exceeded.body).toEqual({
      error: 'Rate limit exceeded',
      limit: 1,
      remaining: 0,
      resetAt: 61_000,
      retryAfter: 60_000,
    });
  });

  it('model middleware stores the result and throws RateLimitExceededError when exceeded', async () => {
    const redis = new MemoryRedis();
    const limiter = new RedisRateLimiter(redis);
    const limit = defineLimit('rl:model:{tenantId:string}', {
      algorithm: 'fixed-window',
      limit: 1,
      window: 1_000,
    });
    const pipeline = new Pipeline<{ tenantId: string }>();
    pipeline.use(rateLimitModel(limit, {
      limiter,
      key: input => ({ tenantId: input.tenantId }),
      now: 0,
    }));
    pipeline.use(async (ctx) => {
      ctx.state.result = 'ok';
    });

    const allowed = new PipelineContext({ tenantId: 'tenant-a' });
    await pipeline.dispatch(allowed);
    expect(allowed.state.rateLimit).toMatchObject({ allowed: true, remaining: 0 });
    expect(allowed.state.result).toBe('ok');

    const exceeded = new PipelineContext({ tenantId: 'tenant-a' });
    try {
      await pipeline.dispatch(exceeded);
      throw new Error('expected rate limit error');
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitExceededError);
      expect((error as RateLimitExceededError).result).toMatchObject({
        allowed: false,
        key: 'rl:model:tenant-a',
        retryAfter: 1_000,
      });
    }
    expect(exceeded.state.rateLimit).toMatchObject({ allowed: false, retryAfter: 1_000 });
  });
});

type TestHttpContext = {
  ip: string;
  status?: number;
  body?: unknown;
  headers: Map<string, string>;
  set(name: string, value: string): void;
};

function createHttpContext(ip: string): TestHttpContext {
  return {
    ip,
    headers: new Map<string, string>(),
    set(name, value) {
      this.headers.set(name, value);
    },
  };
}
