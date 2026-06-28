import type { DefineLimitOptions, DefineLimitResult } from './types';

const supportedAlgorithms = new Set(['fixed-window', 'sliding-window', 'token-bucket']);

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || Math.trunc(value) !== value) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

export function defineLimit<T extends string>(
  key: T,
  options: DefineLimitOptions,
): DefineLimitResult<T> {
  const algorithm = options.algorithm ?? 'fixed-window';
  if (!supportedAlgorithms.has(algorithm)) {
    throw new TypeError(`Unsupported rate limit algorithm: ${algorithm}`);
  }
  assertPositiveInteger(options.limit, 'limit');
  assertPositiveInteger(options.window, 'window');

  return {
    key,
    algorithm,
    limit: options.limit,
    window: options.window,
  };
}
