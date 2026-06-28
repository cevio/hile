export type RedisEvalResult = unknown;

export interface RedisRateLimitLike {
  eval(script: string, numberOfKeys: number, ...keysAndArgs: Array<string | number>): Promise<RedisEvalResult>;
}

export type RateLimitAlgorithm = 'fixed-window' | 'sliding-window' | 'token-bucket';

export type ExtractParams<Template extends string> =
  string extends Template
  ? Record<string, string | number | boolean>
  : Template extends `${string}{${infer Key}:${infer Type}}${infer Rest}`
  ? {
    [K in Key]: Type extends 'string'
    ? string
    : Type extends 'number'
    ? number
    : Type extends 'boolean'
    ? boolean
    : never
  } & ExtractParams<Rest>
  : {};

export interface DefineLimitOptions {
  algorithm?: RateLimitAlgorithm;
  limit: number;
  window: number;
}

export interface DefineLimitResult<T extends string = string> {
  key: T;
  algorithm: RateLimitAlgorithm;
  limit: number;
  window: number;
}

export interface RedisRateLimiterDefaults {
  prefix?: string;
  dryRun?: boolean;
}

export interface ConsumeRateLimitOptions {
  dryRun?: boolean;
  now?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  algorithm: RateLimitAlgorithm;
  key: string;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
  dryRun: boolean;
}
