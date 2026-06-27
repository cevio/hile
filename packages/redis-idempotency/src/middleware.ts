import type { PipelineMiddleware } from '@hile/model';
import { withIdempotency } from './with-idempotency';
import type { IdempotentMiddlewareOptions } from './types';

function resolveFingerprint<TInput extends object>(
  fingerprint: IdempotentMiddlewareOptions<TInput>['fingerprint'],
  input: TInput,
): string {
  return typeof fingerprint === 'function' ? fingerprint(input) : fingerprint;
}

export function idempotent<
  TInput extends object = Record<string, unknown>,
  TResult = unknown,
>(
  options: IdempotentMiddlewareOptions<TInput, TResult>,
): PipelineMiddleware<TInput> {
  return async (ctx, next) => {
    const result = await withIdempotency(
      options.redis,
      options.key(ctx.args),
      async () => {
        await next();
        return ctx.state.result;
      },
      {
        lockTtl: options.lockTtl,
        resultTtl: options.resultTtl,
        wait: options.wait,
        onConflict: options.onConflict,
        pollInterval: options.pollInterval,
        maxPollInterval: options.maxPollInterval,
        fingerprint: resolveFingerprint(options.fingerprint, ctx.args),
        resultCodec: options.resultCodec,
      },
    );
    ctx.state.result = result;
  };
}
