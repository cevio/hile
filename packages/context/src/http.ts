import { getContext, runWithContext } from './store';
import type { ContextData, ContextInput, MaybePromise, RunWithContextOptions } from './types';

export type ContextHttpOptions<
  TContext extends object = ContextData,
  THttpContext = unknown,
> = RunWithContextOptions & {
  read: (ctx: THttpContext) => MaybePromise<ContextInput<TContext>>;
  write?: (context: Readonly<Partial<TContext>>, ctx: THttpContext) => MaybePromise<void>;
};

export type ContextHttpMiddleware<THttpContext = unknown> = (
  ctx: THttpContext,
  next: () => Promise<unknown>,
) => Promise<void>;

export function contextHttp<
  TContext extends object = ContextData,
  THttpContext = unknown,
>(options: ContextHttpOptions<TContext, THttpContext>): ContextHttpMiddleware<THttpContext> {
  return async (ctx, next) => {
    const context = await options.read(ctx);

    await runWithContext<TContext, Promise<void>>(context, async () => {
      let nextError: unknown;

      try {
        await next();
      } catch (err) {
        nextError = err;
      }

      if (options.write) {
        try {
          await options.write(getContext<TContext>(), ctx);
        } catch (writeError) {
          if (nextError === undefined) throw writeError;
        }
      }

      if (nextError !== undefined) throw nextError;
    }, { merge: options.merge });
  };
}
