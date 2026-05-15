import { loadService } from "@hile/core";
import ioredisService from "@hile/ioredis";
import { Cache, DefineCacheResult, ExtractParams } from './define';

export * from './define';
export class RedisCache {
  private readonly _regexp = /\{([^\:]+):[^\}]+\}/g;
  constructor(private readonly prefix: string) { }

  private makeKey<T extends string>(key: T, options: ExtractParams<T>) {
    return this.prefix + key.replace(this._regexp, (_, key) => String(options[key as keyof typeof options]));
  }

  private async _write<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<R | undefined> {
    const key = this.makeKey(target.key, params);
    const cache = await target.fn(params);

    if (!(cache instanceof Cache)) {
      throw new Error('Cache result must be an instance of Cache');
    }

    const redis = await loadService(ioredisService);
    const exists = await redis.exists(key);

    if (cache.data === undefined) {
      if (exists) {
        await redis.del(key);
      }
      return;
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
    const redis = await loadService(ioredisService);
    const exists = await redis.exists(key);

    if (!exists) return await this._write(target, params);
    const text = await redis.get(key);
    if (!text) return await this._write(target, params);
    return JSON.parse(text) as R;
  }


  private async _remove<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<number> {
    const key = this.makeKey(target.key, params);
    const redis = await loadService(ioredisService);
    const exists = await redis.exists(key);
    if (!exists) return 0;
    return await redis.del(key);
  }

  private async _has<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<boolean> {
    const key = this.makeKey(target.key, params);
    const redis = await loadService(ioredisService);
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
      }
    }
  }
}