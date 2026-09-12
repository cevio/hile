import type { MicroCallOptions } from './types.js';

const optionKeys = new Set(['context', 'signal', 'timeout', 'retries']);
const maxInteger = 2_147_483_647;

export function normalizeMicroCallOptions(options: unknown): MicroCallOptions & { readonly retries: number } {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new TypeError('Micro call options and an explicit execution context are required');
  }
  const prototype = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Micro call options must be plain data');
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !optionKeys.has(key)) throw new TypeError('Unsupported unary Micro call option');
    if (!('value' in Object.getOwnPropertyDescriptor(options, key)!)) {
      throw new TypeError('Micro call options must not be accessors');
    }
  }
  const value = options as MicroCallOptions;
  if (!Object.hasOwn(options, 'context') || typeof value.context !== 'object' || value.context === null) {
    throw new TypeError('An explicit Micro execution context is required');
  }
  if (value.signal !== undefined && (typeof value.signal !== 'object' || value.signal === null ||
      typeof value.signal.aborted !== 'boolean' || typeof value.signal.addEventListener !== 'function' ||
      typeof value.signal.removeEventListener !== 'function' || typeof value.signal.throwIfAborted !== 'function')) {
    throw new TypeError('Micro call signal must be an AbortSignal');
  }
  if (value.timeout !== undefined && (!Number.isInteger(value.timeout) || value.timeout < 1 || value.timeout > maxInteger)) {
    throw new TypeError('Micro timeout must be a positive bounded integer');
  }
  if (value.retries !== undefined && (!Number.isInteger(value.retries) || value.retries < 0 || value.retries > maxInteger)) {
    throw new TypeError('Micro retries must be a bounded nonnegative integer');
  }
  return {
    context: value.context,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    ...(value.timeout === undefined ? {} : { timeout: value.timeout }),
    retries: value.retries ?? 0,
  };
}
