export type ContextData = Record<string, unknown>;

export type ContextInput<TContext extends object = ContextData> = Readonly<Partial<TContext>>;

export type ContextSnapshot<TContext extends object = ContextData> = Readonly<Partial<TContext>>;

export type ContextKey<TContext extends object = ContextData> = Extract<keyof TContext, string>;

export type MaybePromise<T> = T | Promise<T>;

export type RunWithContextOptions = {
  /**
   * Merge with the current async context. Defaults to true.
   */
  merge?: boolean;
};
