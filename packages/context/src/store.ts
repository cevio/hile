import { AsyncLocalStorage } from 'node:async_hooks';
import { MissingContextError } from './errors';
import type {
  ContextData,
  ContextInput,
  ContextKey,
  ContextSnapshot,
  RunWithContextOptions,
} from './types';

const storage = new AsyncLocalStorage<ContextData>();

function toStore<TContext extends object>(context: ContextInput<TContext>): ContextData {
  if (!isContextData(context)) return {};
  return { ...context };
}

function freezeSnapshot<TContext extends object>(store: ContextData | undefined): ContextSnapshot<TContext> {
  return Object.freeze({ ...(store ?? {}) }) as ContextSnapshot<TContext>;
}

export function isContextData(value: unknown): value is ContextData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasContext(): boolean {
  return storage.getStore() !== undefined;
}

export function getContext<TContext extends object = ContextData>(): ContextSnapshot<TContext> {
  return freezeSnapshot<TContext>(storage.getStore());
}

export function snapshotContext<TContext extends object = ContextData>(): ContextSnapshot<TContext> {
  return getContext<TContext>();
}

export function runWithContext<
  TContext extends object = ContextData,
  TResult = any,
>(
  context: ContextInput<TContext>,
  callback: () => TResult,
  options: RunWithContextOptions = {},
): TResult {
  const parent = storage.getStore();
  const current = toStore(context);
  const next = options.merge === false ? current : { ...(parent ?? {}), ...current };
  return storage.run(next, callback);
}

type RequiredContext<
  TContext extends object,
  TKey extends ContextKey<TContext>,
> = Readonly<Partial<TContext>> & {
  readonly [K in TKey]-?: Exclude<TContext[K], undefined>;
};

export function requireContext<
  TContext extends object = ContextData,
  const TKeys extends readonly ContextKey<TContext>[] = readonly ContextKey<TContext>[],
>(keys: TKeys): RequiredContext<TContext, TKeys[number]> {
  const context = getContext<TContext>();
  const source = context as Record<string, unknown>;
  const missing = keys.filter(key => source[key] === undefined);

  if (missing.length > 0) {
    throw new MissingContextError(missing);
  }

  return context as RequiredContext<TContext, TKeys[number]>;
}
