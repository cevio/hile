import {
  InvalidExecutionContextError,
  MissingExecutionContextError,
  MissingExecutionContextValueError,
  UnsupportedExecutionContextVersionError,
} from './errors';

export type ContextJsonPrimitive = string | number | boolean | null;

export type ContextJsonValue =
  | ContextJsonPrimitive
  | readonly ContextJsonValue[]
  | { readonly [key: string]: ContextJsonValue };

export type ContextValues = Readonly<Record<string, ContextJsonValue>>;

export type ExecutionContext<TValues extends object = ContextValues> = Readonly<{
  version: 1;
  values: Readonly<TValues>;
}>;

export type InvocationContext<TValues extends object = ContextValues> = Readonly<{
  context: ExecutionContext<TValues>;
  signal: AbortSignal;
}>;

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineOwnValue(target: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function cloneJsonValue(value: unknown, path: string, stack: WeakSet<object>): ContextJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvalidExecutionContextError(path, 'numbers must be finite');
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new InvalidExecutionContextError(path, `${typeof value} values are not serializable`);
  }
  if (stack.has(value)) {
    throw new InvalidExecutionContextError(path, 'cyclic values are not supported');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry, index) => cloneJsonValue(entry, `${path}[${index}]`, stack)));
    }
    if (!isPlainObject(value)) {
      throw new InvalidExecutionContextError(path, 'only plain objects are supported');
    }
    const result: Record<string, ContextJsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      defineOwnValue(result, key, cloneJsonValue(entry, `${path}.${key}`, stack));
    }
    return Object.freeze(result);
  } finally {
    stack.delete(value);
  }
}

function cloneValues<TValues extends object>(values: TValues): Readonly<TValues> {
  if (!isPlainObject(values)) {
    throw new InvalidExecutionContextError('$.values', 'values must be a plain object');
  }
  return cloneJsonValue(values, '$', new WeakSet()) as Readonly<TValues>;
}

export function createExecutionContext<TValues extends object>(
  values: TValues,
): ExecutionContext<TValues> {
  return Object.freeze({
    version: 1 as const,
    values: cloneValues(values),
  });
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === 'object'
    && value !== null
    && typeof (value as AbortSignal).aborted === 'boolean'
    && typeof (value as AbortSignal).addEventListener === 'function'
    && typeof (value as AbortSignal).removeEventListener === 'function';
}

export function createInvocationContext<TValues extends object>(
  context: ExecutionContext<TValues> | undefined,
  signal: AbortSignal | undefined,
  boundary = 'invocation',
): InvocationContext<TValues> {
  if (!context) throw new MissingExecutionContextError(boundary);
  if (!isAbortSignal(signal)) {
    throw new TypeError(`Invalid AbortSignal at ${boundary}`);
  }
  return Object.freeze({
    context: parseExecutionContext<TValues>(context),
    signal,
  });
}

export function parseExecutionContext<TValues extends object = ContextValues>(
  value: unknown,
): ExecutionContext<TValues> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidExecutionContextError('$', 'execution context must be an object');
  }
  const input = value as { version?: unknown; values?: unknown };
  if (input.version !== 1) {
    throw new UnsupportedExecutionContextVersionError(input.version);
  }
  if (typeof input.values !== 'object' || input.values === null || Array.isArray(input.values)) {
    throw new InvalidExecutionContextError('$.values', 'values must be an object');
  }
  return createExecutionContext(input.values as TValues);
}

export function deriveExecutionContext<
  TValues extends object,
  TPatch extends object,
>(
  parent: ExecutionContext<TValues>,
  patch: TPatch,
): ExecutionContext<Omit<TValues, keyof TPatch> & TPatch> {
  const parsed = parseExecutionContext<TValues>(parent);
  return createExecutionContext({
    ...parsed.values,
    ...patch,
  }) as ExecutionContext<Omit<TValues, keyof TPatch> & TPatch>;
}

export function pickExecutionContext<
  TValues extends object,
  const TKeys extends readonly Extract<keyof TValues, string>[],
>(
  context: ExecutionContext<TValues>,
  keys: TKeys,
): ExecutionContext<Pick<TValues, TKeys[number]>> {
  const parsed = parseExecutionContext<TValues>(context);
  const values: Partial<Pick<TValues, TKeys[number]>> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(parsed.values, key)) {
      defineOwnValue(values, key, parsed.values[key]);
    }
  }
  return createExecutionContext(values as Pick<TValues, TKeys[number]>);
}

export function requireExecutionContextValues<
  TValues extends object,
  const TKeys extends readonly Extract<keyof TValues, string>[],
>(
  context: ExecutionContext<TValues>,
  keys: TKeys,
): Readonly<Pick<TValues, TKeys[number]>> {
  const values = parseExecutionContext<TValues>(context).values;
  const missing = keys.filter((key) => values[key] === undefined);
  if (missing.length > 0) {
    throw new MissingExecutionContextValueError(missing);
  }
  const required: Partial<Pick<TValues, TKeys[number]>> = {};
  for (const key of keys) {
    defineOwnValue(required, key, values[key]);
  }
  return Object.freeze(required as Pick<TValues, TKeys[number]>);
}
