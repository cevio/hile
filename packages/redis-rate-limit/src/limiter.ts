import { randomUUID } from 'node:crypto';
import {
  FIXED_WINDOW_RATE_LIMIT,
  SLIDING_WINDOW_RATE_LIMIT,
  TOKEN_BUCKET_RATE_LIMIT,
} from './scripts';
import type {
  ConsumeRateLimitOptions,
  DefineLimitResult,
  ExtractParams,
  RateLimitAlgorithm,
  RateLimitResult,
  RedisRateLimitLike,
  RedisRateLimiterDefaults,
} from './types';

const keyParamPattern = /\{([^:]+):[^}]+\}/g;

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function normalizeEvalArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Redis rate limit script result');
  }
  return value;
}

function toNumber(value: unknown, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid Redis rate limit script ${name}: ${String(value)}`);
  }
  return number;
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === '1' || value === true;
}

function resolveKey<T extends string>(template: T, params: ExtractParams<T>): string {
  return template.replace(keyParamPattern, (_, key: string) => {
    const value = params[key as keyof typeof params];
    if (value === undefined) {
      throw new TypeError(`Missing rate limit key parameter: ${key}`);
    }
    return String(value);
  });
}

function scriptForAlgorithm(algorithm: RateLimitAlgorithm): string {
  switch (algorithm) {
    case 'fixed-window':
      return FIXED_WINDOW_RATE_LIMIT;
    case 'sliding-window':
      return SLIDING_WINDOW_RATE_LIMIT;
    case 'token-bucket':
      return TOKEN_BUCKET_RATE_LIMIT;
    default:
      throw new TypeError(`Unsupported rate limit algorithm: ${String(algorithm)}`);
  }
}

function argsForAlgorithm(algorithm: RateLimitAlgorithm, now: number, limit: number, window: number, dryRun: boolean) {
  const baseArgs: Array<string | number> = [now, limit, window, dryRun ? '1' : '0'];
  if (algorithm === 'sliding-window') {
    return [...baseArgs, `${now}:${randomUUID()}`];
  }
  return baseArgs;
}

export class RedisRateLimiter {
  constructor(
    private readonly redis: RedisRateLimitLike,
    private readonly defaults: RedisRateLimiterDefaults = {},
  ) { }

  public async consume<T extends string>(
    target: DefineLimitResult<T>,
    params: ExtractParams<T>,
    options: ConsumeRateLimitOptions = {},
  ): Promise<RateLimitResult> {
    const now = options.now ?? Date.now();
    assertNonNegativeInteger(now, 'now');
    const key = `${this.defaults.prefix ?? ''}${resolveKey(target.key, params)}`;
    const dryRun = options.dryRun ?? this.defaults.dryRun ?? false;
    const result = normalizeEvalArray(
      await this.redis.eval(
        scriptForAlgorithm(target.algorithm),
        1,
        key,
        ...argsForAlgorithm(target.algorithm, now, target.limit, target.window, dryRun),
      ),
    );

    return {
      allowed: toBoolean(result[0]),
      algorithm: target.algorithm,
      key,
      limit: target.limit,
      remaining: toNumber(result[1], 'remaining'),
      resetAt: toNumber(result[2], 'resetAt'),
      retryAfter: toNumber(result[3], 'retryAfter'),
      dryRun,
    };
  }
}
