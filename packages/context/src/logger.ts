import { getContext } from './store';
import type { ContextData, ContextKey, ContextSnapshot } from './types';

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export type ContextLoggerOptions<TContext extends object = ContextData> = {
  pick?: readonly ContextKey<TContext>[];
  map?: (context: ContextSnapshot<TContext>) => Record<string, unknown>;
};

export type ContextLoggerLike = object & {
  child?: (bindings: Record<string, unknown>) => unknown;
};

export function contextBindings<TContext extends object = ContextData>(
  options: ContextLoggerOptions<TContext> = {},
  context: ContextSnapshot<TContext> = getContext<TContext>(),
): Record<string, unknown> {
  const bindings: Record<string, unknown> = {};
  const source = context as Record<string, unknown>;

  for (const key of options.pick ?? []) {
    if (source[key] !== undefined) {
      bindings[key] = source[key];
    }
  }

  if (options.map) {
    Object.assign(bindings, options.map(context));
  }

  return bindings;
}

export function withContextLogger<
  TContext extends object = ContextData,
  TLogger extends object = any,
>(logger: TLogger, options: ContextLoggerOptions<TContext> = {}): TLogger {
  return new Proxy(logger, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !LOG_METHODS.has(property) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }

      return (...args: unknown[]) => {
        const bindings = contextBindings(options);
        if (Object.keys(bindings).length === 0) {
          return value.apply(target, args);
        }

        const targetLogger = target as ContextLoggerLike;
        if (typeof targetLogger.child === 'function') {
          const child = targetLogger.child(bindings) as Record<string, unknown>;
          const method = child[property];
          if (typeof method === 'function') {
            return method.apply(child, args);
          }
        }

        const [first, ...rest] = args;
        if (isMergeableLogObject(first)) {
          return value.call(target, { ...bindings, ...first }, ...rest);
        }
        return value.call(target, bindings, ...args);
      };
    },
  });
}

function isMergeableLogObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !(value instanceof Error)
  );
}
