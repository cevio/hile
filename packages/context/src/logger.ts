import { parseExecutionContext, type ExecutionContext } from './execution-context';

const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export type ExecutionContextLoggerOptions<TValues extends object> = {
  pick?: readonly Extract<keyof TValues, string>[];
  map?: (values: Readonly<TValues>) => Record<string, unknown>;
};

export type ExecutionContextLoggerLike = object & {
  child?: (bindings: Record<string, unknown>) => unknown;
};

export function executionContextBindings<TValues extends object>(
  context: ExecutionContext<TValues>,
  options: ExecutionContextLoggerOptions<TValues> = {},
): Record<string, unknown> {
  const values = parseExecutionContext<TValues>(context).values;
  const bindings: Record<string, unknown> = {};
  for (const key of options.pick ?? []) {
    if (values[key] !== undefined) defineBinding(bindings, key, values[key]);
  }
  if (options.map) {
    for (const [key, value] of Object.entries(options.map(values))) {
      defineBinding(bindings, key, value);
    }
  }
  return bindings;
}

function defineBinding(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function withExecutionContextLogger<
  TValues extends object,
  TLogger extends object,
>(
  logger: TLogger,
  context: ExecutionContext<TValues>,
  options: ExecutionContextLoggerOptions<TValues> = {},
): TLogger {
  const bindings = executionContextBindings(context, options);
  return new Proxy(logger, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || !LOG_METHODS.has(property) || typeof value !== 'function') {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        if (Object.keys(bindings).length === 0) return value.apply(target, args);
        const targetLogger = target as ExecutionContextLoggerLike;
        if (typeof targetLogger.child === 'function') {
          const child = targetLogger.child(bindings) as Record<string, unknown>;
          const method = child[property];
          if (typeof method === 'function') return method.apply(child, args);
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
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Error);
}
