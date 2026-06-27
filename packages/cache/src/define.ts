export class Cache<R> {
  private _expire: number = 0; // 0: 永不过期
  public readonly __$flag__ = 'cache';
  constructor(public readonly data: R) { }
  public setExpire(seconds: number) {
    this._expire = seconds;
    return this;
  }

  get expire() {
    return this._expire;
  }
}

/** 字面量路径解析 `{k:type}`；`T` 为宽 `string` 时 `params` 退化为宽松索引类型。 */
export type ExtractParams<Template extends string> =
  string extends Template
  ? Record<string, string | number | boolean>
  : Template extends `${string}{${infer Key}:${infer Type}}${infer Rest}`
  ? {
    [K in Key]: Type extends "string"
    ? string
    : Type extends "number"
    ? number
    : Type extends "boolean"
    ? boolean
    : never
  } & ExtractParams<Rest>
  : {};

export type DefineCacheHandler<T extends string = string, R = any> = (opts: ExtractParams<T>) => Promise<Cache<R>>;
export type CacheTagResolver<T extends string = string, R = any> =
  | string[]
  | ((params: ExtractParams<T>, data: R | undefined) => string[]);

export type CacheSingleflightOptions = {
  ttl?: number;
  wait?: number;
  pollInterval?: number;
  maxPollInterval?: number;
};

export type CacheStaleOptions = {
  ttl: number;
};

export type CacheNegativeOptions = {
  ttl: number;
};

export type DefineCacheOptions<T extends string = string, R = any> = {
  fieldable?: boolean;
  singleflight?: boolean | CacheSingleflightOptions;
  stale?: CacheStaleOptions;
  negative?: CacheNegativeOptions;
  tags?: CacheTagResolver<T, R>;
};

export type DefineCacheResult<T extends string = string, R = any> = {
  fn: DefineCacheHandler<T, R>;
  key: T;
  fieldable: boolean;
  options: DefineCacheOptions<T, R>;
}

function normalizeDefineCacheOptions<T extends string, R>(
  options: boolean | DefineCacheOptions<T, R>,
): DefineCacheOptions<T, R> {
  return typeof options === 'boolean'
    ? { fieldable: options }
    : options;
}

function assertCompatibleCacheOptions<T extends string, R>(options: DefineCacheOptions<T, R>): void {
  if (!options.fieldable) return;
  if (options.negative || options.stale) {
    throw new TypeError('fieldable cache cannot be combined with negative or stale cache options');
  }
}

export function defineCache<T extends string = string, R = any>(
  key: T,
  fn: DefineCacheHandler<T, R>,
  options: boolean | DefineCacheOptions<T, R> = false,
): DefineCacheResult<T, R> {
  const normalized = normalizeDefineCacheOptions(options);
  assertCompatibleCacheOptions(normalized);
  return {
    fn,
    key,
    fieldable: normalized.fieldable ?? false,
    options: normalized,
  };
}

// defineCache('user:{id:string}:ddd:{x:number}:idsaf:{y:boolean}', async (params) => {
//   return new Cache({
//     id: params.id,
//     x: params.x,
//     y: params.y,
//   }).setExpire(60);
// });
