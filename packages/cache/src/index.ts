import { Cache, DefineCacheResult, ExtractParams } from './define';
import { ChainableCommander, Redis } from 'ioredis';

export * from './define';
export class RedisCache {
  private readonly _regexp = /\{([^\:]+):[^\}]+\}/g;
  constructor(
    private readonly prefix: string,
    private readonly redis: Redis,
  ) { }

  private makeKey<T extends string>(key: T, options: ExtractParams<T>) {
    return this.prefix + key.replace(this._regexp, (_, key) => String(options[key as keyof typeof options]));
  }

  private async _multi<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    callback: (multi: ChainableCommander, key: string) => unknown
  ) {
    const key = this.makeKey(target.key, params);
    const redis = this.redis;
    const exists = await redis.exists(key);
    if (!exists) await this._write(target, params);
    const multi = redis.multi();
    callback(multi, key);
    return await multi.exec();
  }

  private async _write<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<R | undefined> {
    const key = this.makeKey(target.key, params);
    const cache = await target.fn(params);

    if (cache.__$flag__ !== 'cache') {
      throw new Error('Cache result must be an instance of Cache');
    }

    const redis = this.redis;
    const exists = await redis.exists(key);

    if (cache.data === undefined) {
      if (exists) {
        await redis.del(key);
      }
      return;
    }

    if (target.fieldable) {
      await redis.hset(key, cache.data as object);
      if (cache.expire > 0) {
        await redis.expire(key, cache.expire);
      }
      return cache.data;
    }

    const payload = JSON.stringify(cache.data);
    if (cache.expire > 0) {
      await redis.setex(key, cache.expire, payload);
    } else {
      await redis.set(key, payload);
    }

    return cache.data;
  }

  private async _read<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<R | undefined> {
    const key = this.makeKey(target.key, params);
    const redis = this.redis;

    if (target.fieldable) {
      const fields = await redis.hgetall(key);
      if (!fields) return await this._write<T, R>(target, params);
      if (Object.keys(fields).length === 0) return await this._write<T, R>(target, params);
      return fields as R;
    }
    const text = await redis.get(key);
    if (!text) return await this._write<T, R>(target, params);
    return JSON.parse(text) as R;
  }


  private async _remove<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<number> {
    const key = this.makeKey(target.key, params);
    const redis = this.redis;
    const exists = await redis.exists(key);
    if (!exists) return 0;
    return await redis.del(key);
  }

  private async _has<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<boolean> {
    const key = this.makeKey(target.key, params);
    const redis = this.redis;
    const exists = await redis.exists(key);
    return !!exists;
  }

  public async loadCache<T extends string, R>(target: DefineCacheResult<T, R>) {
    return {
      write: async (params: ExtractParams<T>) => {
        return await this._write(target, params);
      },
      read: async (params: ExtractParams<T>) => {
        return await this._read(target, params);
      },
      remove: async (params: ExtractParams<T>) => {
        return await this._remove(target, params);
      },
      has: async (params: ExtractParams<T>) => {
        return await this._has(target, params);
      },
      multi: async (params: ExtractParams<T>, callback: (multi: ChainableCommander, key: string) => unknown) => {
        return await this._multi(target, params, callback);
      }
    }
  }
}