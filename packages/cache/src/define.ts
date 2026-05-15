export class Cache<R> {
  private _expire: number = 0; // 0: 永不过期
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
export type DefineCacheResult<T extends string = string, R = any> = {
  fn: DefineCacheHandler<T, R>;
  key: string;
}

export function defineCache<T extends string = string, R = any>(key: T, fn: DefineCacheHandler<T, R>): DefineCacheResult<T, R> {
  return {
    fn,
    key,
  };
}

// defineCache('user:{id:string}:ddd:{x:number}:idsaf:{y:boolean}', async (params) => {
//   return new Cache({
//     id: params.id,
//     x: params.x,
//     y: params.y,
//   }).setExpire(60);
// });