import type { PipelineContext, PipelineMiddleware } from '@hile/model';
import { requireContext, runWithContext } from './store';
import type {
  ContextData,
  ContextInput,
  ContextKey,
  MaybePromise,
  RunWithContextOptions,
} from './types';

export type ContextModelOptions<
  TInput extends object = Record<string, unknown>,
  TContext extends object = ContextData,
> = RunWithContextOptions & {
  read: (input: TInput, ctx: PipelineContext<TInput>) => MaybePromise<ContextInput<TContext>>;
};

export function contextModel<
  TInput extends object = Record<string, unknown>,
  TContext extends object = ContextData,
>(options: ContextModelOptions<TInput, TContext>): PipelineMiddleware<TInput> {
  return async (ctx, next) => {
    const context = await options.read(ctx.args, ctx);
    await runWithContext<TContext, Promise<void>>(context, () => next(), { merge: options.merge });
  };
}

export function requireContextModel<
  TInput extends object = Record<string, unknown>,
  TContext extends object = ContextData,
>(keys: readonly ContextKey<TContext>[]): PipelineMiddleware<TInput> {
  return async (_ctx, next) => {
    requireContext<TContext>(keys);
    await next();
  };
}
