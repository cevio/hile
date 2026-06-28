/**
 * Integration tests for @hile/redis-rate-limit.
 *
 * Requires Redis on 127.0.0.1:6379.
 * Run with: INTEGRATION=true pnpm --filter @hile/redis-rate-limit test
 */
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RedisRateLimiter,
  defineLimit,
} from './index';

const isIntegration = process.env.INTEGRATION === 'true';

describe.skipIf(!isIntegration)('integration | real Redis Lua scripts', () => {
  let redis: Redis;
  let prefix: string;

  beforeAll(async () => {
    redis = new Redis({ host: '127.0.0.1', port: 6379 });
    await redis.ping().catch((error: Error) => {
      throw new Error(
        `Redis unreachable (127.0.0.1:6379): ${error.message}. ` +
        'Start Redis before running rate-limit integration tests.',
      );
    });
    prefix = `test:rate-limit:${randomUUID()}:`;
  }, 10_000);

  afterAll(async () => {
    if (redis && prefix) {
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    await redis?.quit();
  }, 10_000);

  it('runs the sliding-window script against Redis sorted sets', async () => {
    const limiter = new RedisRateLimiter(redis, { prefix });
    const limit = defineLimit('sliding:{id:string}', {
      algorithm: 'sliding-window',
      limit: 2,
      window: 10_000,
    });

    await expect(limiter.consume(limit, { id: 'a' }, { now: 100_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 1, resetAt: 110_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 101_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, resetAt: 110_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 102_000 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0, retryAfter: 8_000, resetAt: 110_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 110_001 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, retryAfter: 0, resetAt: 111_000 });

    await expect(redis.zcard(`${prefix}sliding:a`)).resolves.toBe(2);
  });

  it('runs the token-bucket script with gradual refill', async () => {
    const limiter = new RedisRateLimiter(redis, { prefix });
    const limit = defineLimit('bucket:{id:string}', {
      algorithm: 'token-bucket',
      limit: 4,
      window: 4_000,
    });

    await limiter.consume(limit, { id: 'a' }, { now: 200_000 });
    await limiter.consume(limit, { id: 'a' }, { now: 200_000 });
    await limiter.consume(limit, { id: 'a' }, { now: 200_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 200_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, resetAt: 204_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 200_500 }))
      .resolves.toMatchObject({ allowed: false, remaining: 0, retryAfter: 500, resetAt: 201_000 });
    await expect(limiter.consume(limit, { id: 'a' }, { now: 201_000 }))
      .resolves.toMatchObject({ allowed: true, remaining: 0, retryAfter: 0, resetAt: 205_000 });

    await expect(redis.hget(`${prefix}bucket:a`, 'tokens').then(Number)).resolves.toBe(0);
  });

  it('does not mutate Redis during dry-run checks', async () => {
    const limiter = new RedisRateLimiter(redis, { prefix });
    const sliding = defineLimit('dry:sliding:{id:string}', {
      algorithm: 'sliding-window',
      limit: 1,
      window: 1_000,
    });
    const bucket = defineLimit('dry:bucket:{id:string}', {
      algorithm: 'token-bucket',
      limit: 1,
      window: 1_000,
    });

    await expect(limiter.consume(sliding, { id: 'a' }, { dryRun: true, now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: true });
    await expect(limiter.consume(bucket, { id: 'a' }, { dryRun: true, now: 0 }))
      .resolves.toMatchObject({ allowed: true, dryRun: true });

    await expect(redis.exists(`${prefix}dry:sliding:a`, `${prefix}dry:bucket:a`)).resolves.toBe(0);
  });
});
