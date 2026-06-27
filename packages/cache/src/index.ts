import { RedisLock } from '@hile/redis-lock';
import { Cache, DefineCacheResult, ExtractParams } from './define';
import {
  decodeCacheValue,
  encodeCacheValue,
  encodeNegative,
  resolveNegativeTtl,
  resolveRedisTtl,
  type CacheReadResult,
} from './payload';
import { resolveSingleflightOptions } from './options';
import { CacheTagIndex } from './tags';
import { ChainableCommander, Redis } from 'ioredis';

export * from './define';
export * from './options';
export * from './payload';
export * from './tags';

const TAG_MUTATION_LOCK_OPTIONS = {
  ttl: 10_000,
  wait: 10_000,
};

export type RedisCacheOptions = {
  locks?: RedisLock;
};

export class RedisCache {
  private readonly _regexp = /\{([^\:]+):[^\}]+\}/g;
  private readonly locks: RedisLock;
  private readonly tags: CacheTagIndex;

  constructor(
    private readonly prefix: string,
    private readonly redis: Redis,
    options: RedisCacheOptions = {},
  ) {
    this.locks = options.locks ?? new RedisLock(redis);
    this.tags = new CacheTagIndex(prefix, redis);
  }

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
    if (!exists) await this._writeWithKey(target, params, key);
    const multi = redis.multi();
    callback(multi, key);
    return await multi.exec();
  }

  private async _write<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<R | undefined> {
    const key = this.makeKey(target.key, params);
    return this._writeWithKey(target, params, key);
  }

  private async _writeWithKey<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    key: string,
  ): Promise<R | undefined> {
    const cache = await target.fn(params);

    if (!cache || cache.__$flag__ !== 'cache') {
      throw new Error('Cache result must be an instance of Cache');
    }

    if (!target.options.tags) {
      return this._storeCacheResult(target, params, key, cache);
    }

    const nextTags = cache.data === undefined && resolveNegativeTtl(target.options) === undefined
      ? []
      : this.tags.resolveTags(target, params, cache.data);

    return this.withKeyTagMutationLock(target, params, key, nextTags, () => {
      return this._storeCacheResult(target, params, key, cache, nextTags);
    });
  }

  private async _storeCacheResult<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    key: string,
    cache: Cache<R>,
    resolvedTags?: string[],
  ): Promise<R | undefined> {
    const redis = this.redis;
    const exists = await redis.exists(key);

    if (cache.data === undefined) {
      const negativeTtl = resolveNegativeTtl(target.options);
      if (negativeTtl !== undefined) {
        await redis.setex(key, negativeTtl, encodeNegative());
        await this.rememberTags(target, params, undefined, key, resolvedTags);
        return;
      }
      if (exists) await redis.del(key);
      if (target.options.tags) await this.tags.forget(target, params, key);
      return;
    }

    if (target.fieldable) {
      await redis.hset(key, cache.data as object);
      if (cache.expire > 0) {
        await redis.expire(key, cache.expire);
      } else {
        await redis.persist(key);
      }
      await this.rememberTags(target, params, cache.data, key, resolvedTags);
      return cache.data;
    }

    const payload = encodeCacheValue(cache.data, cache.expire, target.options);
    const ttl = resolveRedisTtl(cache.expire, target.options);
    if (ttl > 0) {
      await redis.setex(key, ttl, payload);
    } else {
      await redis.set(key, payload);
    }

    await this.rememberTags(target, params, cache.data, key, resolvedTags);
    return cache.data;
  }

  private async rememberTags<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    data: R | undefined,
    key: string,
    resolvedTags?: string[],
  ): Promise<void> {
    if (!target.options.tags) return;
    if (resolvedTags) {
      await this.tags.rememberTags(key, resolvedTags);
      return;
    }
    await this.tags.remember(target, params, data, key);
  }

  private async _read<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<R | undefined> {
    const key = this.makeKey(target.key, params);
    const cached = await this._readExisting<T, R>(target, key);
    if (cached.hit) {
      if (cached.stale) {
        void this._refreshStale(target, params, key);
      }
      return cached.value;
    }

    const singleflight = resolveSingleflightOptions(target.options);
    if (singleflight) {
      return this.locks.withLock(`${key}:lock`, singleflight, async () => {
        const current = await this._readExisting<T, R>(target, key);
        if (current.hit) return current.value;
        return this._writeWithKey(target, params, key);
      });
    }

    return await this._writeWithKey<T, R>(target, params, key);
  }

  private async _readExisting<T extends string, R>(
    target: DefineCacheResult<T, R>,
    key: string,
  ): Promise<CacheReadResult<R>> {
    if (target.fieldable) {
      const fields = await this.redis.hgetall(key);
      if (!fields || Object.keys(fields).length === 0) return { hit: false };
      return { hit: true, value: fields as R, stale: false };
    }
    const text = await this.redis.get(key);
    if (!text) return { hit: false };
    return decodeCacheValue<R, T>(text, target.options);
  }

  private async _refreshStale<T extends string, R>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    key: string,
  ): Promise<void> {
    try {
      const singleflight = resolveSingleflightOptions(target.options);
      if (singleflight) {
        await this.locks.withLock(`${key}:lock`, {
          ...singleflight,
          wait: 0,
        }, async () => {
          await this._writeWithKey(target, params, key);
        });
        return;
      }
      await this._writeWithKey(target, params, key);
    } catch {
      // stale cache should keep serving the previous value when refresh fails
    }
  }


  private async _remove<T extends string, R>(target: DefineCacheResult<T, R>, params: ExtractParams<T>): Promise<number> {
    const key = this.makeKey(target.key, params);
    if (target.options.tags) {
      return this.withKeyTagMutationLock(target, params, key, [], async () => {
        const removed = await this.redis.del(key);
        await this.tags.forget(target, params, key);
        return removed;
      });
    }

    const redis = this.redis;
    const exists = await redis.exists(key);
    if (!exists) return 0;
    const removed = await redis.del(key);
    if (removed > 0) await this.tags.forget(target, params, key);
    return removed;
  }

  private async withKeyTagMutationLock<T extends string, R, TResult>(
    target: DefineCacheResult<T, R>,
    params: ExtractParams<T>,
    key: string,
    nextTags: string[],
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    return this.withMutationLocks([this.makeKeyMutationLockKey(key)], async () => {
      const previousTags = await this.tags.readKeyTags(key);
      const legacyTags = previousTags.length === 0
        ? this.tags.resolveTags(target, params, undefined)
        : [];
      const tagLockKeys = [...previousTags, ...legacyTags, ...nextTags]
        .map(tag => this.makeTagMutationLockKey(tag));
      return this.withMutationLocks(tagLockKeys, callback);
    });
  }

  private async withMutationLocks<TResult>(
    lockKeys: string[],
    callback: () => Promise<TResult>,
  ): Promise<TResult> {
    const keys = [...new Set(lockKeys)].sort();
    const run = async (index: number): Promise<TResult> => {
      if (index >= keys.length) return callback();
      const lockKey = keys[index];
      return this.locks.withLock(lockKey, TAG_MUTATION_LOCK_OPTIONS, async () => run(index + 1));
    };
    return run(0);
  }

  private makeKeyMutationLockKey(key: string): string {
    return `${key}:hile-cache:mutation-lock`;
  }

  private makeTagMutationLockKey(tag: string): string {
    return `${this.prefix}tag:${tag}:mutation-lock`;
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

  public async removeTag(tag: string): Promise<number> {
    return this.withMutationLocks([this.makeTagMutationLockKey(tag)], () => {
      return this.tags.removeTag(tag);
    });
  }
}
