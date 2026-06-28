import type { PipelineMiddleware } from '@hile/model';
import { RateLimitExceededError } from './errors';
import type { RedisRateLimiter } from './limiter';
import type {
  DefineLimitResult,
  ExtractParams,
  RateLimitResult,
} from './types';

type MaybePromise<T> = T | Promise<T>;
type DynamicOption<TSource, TValue> = TValue | ((source: TSource) => MaybePromise<TValue>);

export type RateLimitHttpContext = {
  ip: string;
  status?: number;
  body?: unknown;
  set(name: string, value: string): void;
};

export type RateLimitHttpNext = () => Promise<unknown>;

export type RateLimitHttpMiddleware<TContext extends RateLimitHttpContext = RateLimitHttpContext> = (
  ctx: TContext,
  next: RateLimitHttpNext,
) => Promise<void>;

export interface RateLimitHttpOptions<
  TLimitKey extends string = string,
  TContext extends RateLimitHttpContext = RateLimitHttpContext,
> {
  limiter: RedisRateLimiter;
  key: (ctx: TContext) => MaybePromise<ExtractParams<TLimitKey>>;
  dryRun?: DynamicOption<TContext, boolean>;
  now?: DynamicOption<TContext, number>;
  body?: (result: RateLimitResult, ctx: TContext) => MaybePromise<unknown>;
}

export interface RateLimitModelOptions<
  TLimitKey extends string = string,
  TInput extends object = Record<string, unknown>,
> {
  limiter: RedisRateLimiter;
  key: (input: TInput) => MaybePromise<ExtractParams<TLimitKey>>;
  dryRun?: DynamicOption<TInput, boolean>;
  now?: DynamicOption<TInput, number>;
  stateKey?: string;
}

async function resolveDynamic<TSource, TValue>(
  option: DynamicOption<TSource, TValue> | undefined,
  source: TSource,
): Promise<TValue | undefined> {
  if (typeof option === 'function') {
    return (option as (source: TSource) => MaybePromise<TValue>)(source);
  }
  return option;
}

function seconds(ms: number): string {
  return String(Math.ceil(ms / 1000));
}

function setRateLimitHeaders(
  ctx: RateLimitHttpContext,
  result: RateLimitResult,
  now: number,
): void {
  ctx.set('X-RateLimit-Limit', String(result.limit));
  ctx.set('X-RateLimit-Remaining', String(result.remaining));
  ctx.set('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
  ctx.set('RateLimit-Limit', String(result.limit));
  ctx.set('RateLimit-Remaining', String(result.remaining));
  ctx.set('RateLimit-Reset', seconds(Math.max(0, result.resetAt - now)));
  if (result.dryRun) ctx.set('X-RateLimit-Dry-Run', '1');
  if (!result.allowed && !result.dryRun) {
    ctx.set('Retry-After', seconds(result.retryAfter));
  }
}

function defaultExceededBody(result: RateLimitResult): Record<string, number | string> {
  return {
    error: 'Rate limit exceeded',
    limit: result.limit,
    remaining: result.remaining,
    resetAt: result.resetAt,
    retryAfter: result.retryAfter,
  };
}

export function rateLimitHttp<
  TLimitKey extends string,
  TContext extends RateLimitHttpContext = RateLimitHttpContext,
>(
  target: DefineLimitResult<TLimitKey>,
  options: RateLimitHttpOptions<TLimitKey, TContext>,
): RateLimitHttpMiddleware<TContext> {
  return async (ctx, next) => {
    const now = await resolveDynamic(options.now, ctx);
    const dryRun = await resolveDynamic(options.dryRun, ctx);
    const result = await options.limiter.consume(target, await options.key(ctx), { now, dryRun });
    setRateLimitHeaders(ctx, result, now ?? Date.now());

    if (!result.allowed && !result.dryRun) {
      ctx.status = 429;
      ctx.body = options.body ? await options.body(result, ctx) : defaultExceededBody(result);
      return;
    }

    await next();
  };
}

export function rateLimitModel<
  TLimitKey extends string,
  TInput extends object = Record<string, unknown>,
>(
  target: DefineLimitResult<TLimitKey>,
  options: RateLimitModelOptions<TLimitKey, TInput>,
): PipelineMiddleware<TInput> {
  return async (ctx, next) => {
    const now = await resolveDynamic(options.now, ctx.args);
    const dryRun = await resolveDynamic(options.dryRun, ctx.args);
    const result = await options.limiter.consume(target, await options.key(ctx.args), { now, dryRun });
    ctx.state[options.stateKey ?? 'rateLimit'] = result;

    if (!result.allowed && !result.dryRun) {
      throw new RateLimitExceededError(result);
    }

    await next();
  };
}
