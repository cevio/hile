import type { CacheSingleflightOptions, DefineCacheOptions } from './define';

export type ResolvedSingleflightOptions = {
  ttl: number;
  wait: number;
  pollInterval?: number;
  maxPollInterval?: number;
};

export function resolveSingleflightOptions<T extends string, R>(
  options: DefineCacheOptions<T, R>,
): ResolvedSingleflightOptions | undefined {
  if (!options.singleflight) return undefined;
  const singleflight: CacheSingleflightOptions = options.singleflight === true ? {} : options.singleflight;
  const ttl = singleflight.ttl ?? 10_000;
  return {
    ttl,
    wait: singleflight.wait ?? ttl,
    pollInterval: singleflight.pollInterval,
    maxPollInterval: singleflight.maxPollInterval,
  };
}
