import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Redis from 'ioredis'
import { RedisCache, defineCache, Cache, decodeCacheValue } from './index'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('@hile/cache', () => {
  let redis: Redis
  let cache: RedisCache

  const testCache = defineCache('key:{id:string}', async ({ id }) => {
    return new Cache({ id, value: `hello-${id}` }).setExpire(60)
  })

  beforeAll(async () => {
    redis = new Redis()
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error) => reject(e)
      redis.once('error', onError)
      redis.once('connect', () => {
        redis.off('error', onError)
        resolve()
      })
    })
    cache = new RedisCache('test:', redis)
  })

  afterAll(async () => {
    const { remove } = await cache.loadCache(testCache)
    await remove({ id: '1' })
    await remove({ id: '2' })
    await remove({ id: '3' })
    const { remove: removeMulti } = await cache.loadCache(
      defineCache('multi:{a:string}:{b:number}', async () => new Cache(null))
    )
    await removeMulti({ a: 'x', b: 1 })
    const { remove: removePerm } = await cache.loadCache(
      defineCache('perm:{id:string}', async () => new Cache('perm'))
    )
    await removePerm({ id: '1' })
    redis.disconnect()
  })

  /* ============ read ============ */

  it('read returns data after write', async () => {
    const { write, read, remove } = await cache.loadCache(testCache)

    await write({ id: '1' })
    const result = await read({ id: '1' })
    expect(result).toEqual({ id: '1', value: 'hello-1' })

    await remove({ id: '1' })
  })

  it('read triggers write on cache miss', async () => {
    const { read, remove } = await cache.loadCache(testCache)

    const result = await read({ id: '2' })
    expect(result).toEqual({ id: '2', value: 'hello-2' })

    await remove({ id: '2' })
  })

  it('read returns undefined for non-existent key without handler', async () => {
    const noopCache = defineCache('noop:{id:string}', async () => {
      return new Cache(undefined)
    })
    const { read } = await cache.loadCache(noopCache)
    const result = await read({ id: '1' })
    expect(result).toBeUndefined()
  })

  /* ============ write ============ */

  it('write stores data and returns it', async () => {
    const { write, remove } = await cache.loadCache(testCache)

    const result = await write({ id: '3' })
    expect(result).toEqual({ id: '3', value: 'hello-3' })

    const raw = await redis.get('test:key:3')
    expect(JSON.parse(raw!)).toEqual({ id: '3', value: 'hello-3' })

    await remove({ id: '3' })
  })

  it('write with expire > 0 sets TTL in Redis', async () => {
    const ttlCache = defineCache('ttl:{id:string}', async ({ id }) => {
      return new Cache({ id }).setExpire(120)
    })
    const { write, remove } = await cache.loadCache(ttlCache)

    await write({ id: '1' })

    const ttl = await redis.ttl('test:ttl:1')
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(120)

    await remove({ id: '1' })
  })

  it('write with expire = 0 creates permanent key (no TTL)', async () => {
    const permCache = defineCache('perm:{id:string}', async ({ id }) => {
      return new Cache(`perm-${id}`)
    })
    const { write, remove } = await cache.loadCache(permCache)

    await write({ id: '1' })

    const ttl = await redis.ttl('test:perm:1')
    expect(ttl).toBe(-1)

    await remove({ id: '1' })
  })

  it('fieldable write with expire = 0 clears an existing TTL', async () => {
    let expire = 60
    const hashCache = defineCache('hash-ttl:{id:string}', async ({ id }) => {
      return new Cache({ id, name: `name-${id}` }).setExpire(expire)
    }, true)
    const { write, remove } = await cache.loadCache(hashCache)

    await write({ id: '1' })
    expect(await redis.ttl('test:hash-ttl:1')).toBeGreaterThan(0)

    expire = 0
    await write({ id: '1' })

    expect(await redis.ttl('test:hash-ttl:1')).toBe(-1)

    await remove({ id: '1' })
  })

  it('write with undefined data on existing key deletes it', async () => {
    const { write } = await cache.loadCache(testCache)

    await write({ id: '1' })
    expect(await redis.exists('test:key:1')).toBe(1)

    const undefCache = defineCache('key:{id:string}', async () => new Cache(undefined))
    const { write: writeUndef } = await cache.loadCache(undefCache)
    await writeUndef({ id: '1' })

    expect(await redis.exists('test:key:1')).toBe(0)
  })

  it('write with undefined data on non-existent key does nothing', async () => {
    const undefCache = defineCache('noop:{id:string}', async () => new Cache(undefined))
    const { write } = await cache.loadCache(undefCache)

    await expect(write({ id: 'nonexistent' })).resolves.toBeUndefined()
    expect(await redis.exists('test:noop:nonexistent')).toBe(0)
  })

  /* ============ remove ============ */

  it('remove returns 0 for non-existent key', async () => {
    const { remove } = await cache.loadCache(testCache)
    const count = await remove({ id: 'nonexistent' })
    expect(count).toBe(0)
  })

  it('remove returns 1 for existing key', async () => {
    const { write, remove } = await cache.loadCache(testCache)

    await write({ id: '1' })
    const count = await remove({ id: '1' })
    expect(count).toBe(1)
    expect(await redis.exists('test:key:1')).toBe(0)
  })

  /* ============ has ============ */

  it('has returns correct boolean', async () => {
    const { write, has, remove } = await cache.loadCache(testCache)

    await write({ id: '1' })
    expect(await has({ id: '1' })).toBe(true)

    await remove({ id: '1' })
    expect(await has({ id: '1' })).toBe(false)
  })

  /* ============ prefix ============ */

  it('prefix is applied to all keys', async () => {
    const prefixed = new RedisCache('custom-prefix:', redis)
    const { write, read, remove } = await prefixed.loadCache(testCache)

    await write({ id: '1' })

    expect(await redis.exists('custom-prefix:key:1')).toBe(1)
    expect(await redis.exists('test:key:1')).toBe(0)

    const result = await read({ id: '1' })
    expect(result).toEqual({ id: '1', value: 'hello-1' })

    await remove({ id: '1' })
  })

  /* ============ multi-param template ============ */

  it('supports multiple params in key template', async () => {
    const multiCache = defineCache('multi:{a:string}:{b:number}', async ({ a, b }) => {
      return new Cache({ a, b, sum: b }).setExpire(60)
    })
    const { write, read, remove } = await cache.loadCache(multiCache)

    await write({ a: 'x', b: 42 })

    expect(await redis.exists('test:multi:x:42')).toBe(1)

    const result = await read({ a: 'x', b: 42 })
    expect(result).toEqual({ a: 'x', b: 42, sum: 42 })

    await remove({ a: 'x', b: 42 })
  })

  it('supports boolean params in key template', async () => {
    const boolCache = defineCache('flag:{v:boolean}', async ({ v }) => {
      return new Cache({ verified: v }).setExpire(60)
    })
    const { write, read, remove } = await cache.loadCache(boolCache)

    await write({ v: true })
    expect(await redis.exists('test:flag:true')).toBe(1)
    const result = await read({ v: true })
    expect(result).toEqual({ verified: true })

    await remove({ v: true })
  })

  /* ============ handler receives correct params ============ */

  it('handler receives all params correctly', async () => {
    const handler = vi.fn(async ({ id, page }: { id: string; page: number }) => {
      return new Cache({ id, page }).setExpire(60)
    })
    const spyCache = defineCache('spy:{id:string}:{page:number}', handler)
    const { read, remove } = await cache.loadCache(spyCache)

    await read({ id: 'user-1', page: 3 })
    expect(handler).toHaveBeenCalledWith({ id: 'user-1', page: 3 })

    await remove({ id: 'user-1', page: 3 })
  })

  /* ============ error propagation ============ */

  it('throws when handler returns non-Cache value', async () => {
    const badCache = defineCache('bad:{id:string}', async () => {
      return null as unknown as Cache<unknown>
    })
    const { write } = await cache.loadCache(badCache)
    await expect(write({ id: '1' })).rejects.toThrow('Cache result must be an instance of Cache')
  })

  it('propagates handler error', async () => {
    const errCache = defineCache('err:{id:string}', async () => {
      throw new Error('handler error')
    })
    const { read } = await cache.loadCache(errCache)
    await expect(read({ id: '1' })).rejects.toThrow('handler error')
  })

  /* ============ TTL race / missing data ============ */

  it('read with expired cache triggers re-write', async () => {
    const { write, read, remove } = await cache.loadCache(testCache)

    await write({ id: 'ttlrace1' })

    vi.spyOn(redis, 'get').mockResolvedValueOnce(null)

    const result = await read({ id: 'ttlrace1' })
    expect(result).toEqual({ id: 'ttlrace1', value: 'hello-ttlrace1' })

    await remove({ id: 'ttlrace1' })
  })

  /* ============ data integrity ============ */

  it('preserves complex data through JSON serialization roundtrip', async () => {
    const complexData = {
      id: 'u-1',
      nested: { arr: [1, 2, 3], flag: true },
      date: '2024-01-01T00:00:00.000Z',
      score: 99.5,
      tags: ['a', 'b', 'c'],
    }
    const complexCache = defineCache('complex:{id:string}', async ({ id }) => {
      return new Cache({ ...complexData, id }).setExpire(60)
    })
    const { write, read, remove } = await cache.loadCache(complexCache)

    await write({ id: '1' })
    const result = await read({ id: '1' })
    expect(result).toEqual({ ...complexData, id: '1' })

    await remove({ id: '1' })
  })

  it('preserves user data that contains the internal payload marker name', async () => {
    const markerCache = defineCache('marker:{id:string}', async ({ id }) => {
      return new Cache({ id, __$hile_cache: true, value: `marker-${id}` }).setExpire(60)
    })
    const { write, read, remove } = await cache.loadCache(markerCache)

    await write({ id: '1' })

    await expect(read({ id: '1' })).resolves.toEqual({
      id: '1',
      __$hile_cache: true,
      value: 'marker-1',
    })

    await remove({ id: '1' })
  })

  it('preserves user data whose marker value matches internal payload sentinels', async () => {
    let value: unknown = { __$hile_cache: 'negative' }
    const markerCache = defineCache('marker-sentinel:{id:string}', async () => {
      return new Cache(value).setExpire(60)
    })
    const { write, read, remove } = await cache.loadCache(markerCache)

    await write({ id: '1' })
    await expect(read({ id: '1' })).resolves.toEqual({ __$hile_cache: 'negative' })

    value = { __$hile_cache: 'value', data: { nested: true }, freshUntil: 123 }
    await write({ id: '1' })
    await expect(read({ id: '1' })).resolves.toEqual({
      __$hile_cache: 'value',
      data: { nested: true },
      freshUntil: 123,
    })

    await remove({ id: '1' })
  })

  it('decodes plain cache values without requiring cache options', () => {
    expect(decodeCacheValue(JSON.stringify({ ok: true }))).toEqual({
      hit: true,
      value: { ok: true },
      stale: false,
    })
  })

  it('rejects fieldable cache options that require string payloads', () => {
    expect(() => defineCache('fieldable-negative:{id:string}', async () => {
      return new Cache({ name: 'alice' })
    }, {
      fieldable: true,
      negative: { ttl: 60 },
    })).toThrow(/fieldable/i)

    expect(() => defineCache('fieldable-stale:{id:string}', async () => {
      return new Cache({ name: 'alice' }).setExpire(60)
    }, {
      fieldable: true,
      stale: { ttl: 60 },
    })).toThrow(/fieldable/i)
  })

  /* ============ concurrent access ============ */

  it('handles concurrent reads on the same key', async () => {
    const { write, read, remove } = await cache.loadCache(testCache)

    await write({ id: '1' })

    const results = await Promise.all([
      read({ id: '1' }),
      read({ id: '1' }),
      read({ id: '1' }),
    ])
    for (const r of results) {
      expect(r).toEqual({ id: '1', value: 'hello-1' })
    }

    await remove({ id: '1' })
  })

  it('handles concurrent reads on different keys', async () => {
    const { write, read, remove } = await cache.loadCache(testCache)

    await write({ id: '1' })
    await write({ id: '2' })

    const results = await Promise.all([
      read({ id: '1' }),
      read({ id: '2' }),
    ])
    expect(results[0]).toEqual({ id: '1', value: 'hello-1' })
    expect(results[1]).toEqual({ id: '2', value: 'hello-2' })

    await remove({ id: '1' })
    await remove({ id: '2' })
  })

  it('singleflight coalesces concurrent cache misses for the same key', async () => {
    const handler = vi.fn(async ({ id }: { id: string }) => {
      await sleep(40)
      return new Cache({ id, value: `single-${id}` }).setExpire(60)
    })
    const singleflightCache = defineCache('singleflight:{id:string}', handler, {
      singleflight: { ttl: 1000, wait: 1000 },
    })
    const { read, remove } = await cache.loadCache(singleflightCache)

    const results = await Promise.all([
      read({ id: '1' }),
      read({ id: '1' }),
      read({ id: '1' }),
    ])

    expect(results).toEqual([
      { id: '1', value: 'single-1' },
      { id: '1', value: 'single-1' },
      { id: '1', value: 'single-1' },
    ])
    expect(handler).toHaveBeenCalledTimes(1)

    await remove({ id: '1' })
  })

  it('negative cache avoids repeated handler calls for undefined data', async () => {
    const handler = vi.fn(async () => new Cache(undefined))
    const negativeCache = defineCache('negative:{id:string}', handler, {
      negative: { ttl: 60 },
    })
    const { read, remove } = await cache.loadCache(negativeCache)

    await expect(read({ id: '1' })).resolves.toBeUndefined()
    await expect(read({ id: '1' })).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalledTimes(1)

    await remove({ id: '1' })
  })

  it('stale cache returns stale data and refreshes in the background', async () => {
    const now = Date.now()
    const dateNow = vi.spyOn(Date, 'now')
    let version = 0
    const staleCache = defineCache('stale:{id:string}', async ({ id }) => {
      return new Cache({ id, version: ++version }).setExpire(10)
    }, {
      stale: { ttl: 60 },
    })
    const { write, read, remove } = await cache.loadCache(staleCache)

    dateNow.mockReturnValue(now)
    await write({ id: '1' })

    dateNow.mockReturnValue(now + 11_000)
    await expect(read({ id: '1' })).resolves.toEqual({ id: '1', version: 1 })

    await sleep(30)
    dateNow.mockReturnValue(now + 12_000)
    await expect(read({ id: '1' })).resolves.toEqual({ id: '1', version: 2 })

    dateNow.mockRestore()
    await remove({ id: '1' })
  })

  it('removes cached keys by tag', async () => {
    const taggedCache = defineCache('tagged:{id:string}', async ({ id }) => {
      return new Cache({ id }).setExpire(60)
    }, {
      tags: ({ id }) => ['users', `user:${id}`],
    })
    const { write } = await cache.loadCache(taggedCache)

    await write({ id: '1' })
    await write({ id: '2' })

    await expect(cache.removeTag('users')).resolves.toBe(2)
    expect(await redis.exists('test:tagged:1')).toBe(0)
    expect(await redis.exists('test:tagged:2')).toBe(0)
  })

  it('removeTag returns only the number of existing cache keys it deletes', async () => {
    await redis.sadd('test:tag:stale-tag', 'test:missing-tagged-key')

    await expect(cache.removeTag('stale-tag')).resolves.toBe(0)
    expect(await redis.exists('test:tag:stale-tag')).toBe(0)
  })

  it('keeps keys written during tag removal discoverable by that tag', async () => {
    const taggedCache = defineCache('tag-remove-race:{id:string}', async ({ id }) => {
      return new Cache({ id }).setExpire(60)
    }, {
      tags: ['remove-race'],
    })
    const { write, remove } = await cache.loadCache(taggedCache)
    const originalDel = redis.del.bind(redis)
    let insertedDuringRemoval = false
    const del = vi.spyOn(redis, 'del').mockImplementation(async (...keys: string[]) => {
      const removed = await originalDel(...keys)
      if (!insertedDuringRemoval && keys.length === 1 && keys[0] === 'test:tag-remove-race:1') {
        insertedDuringRemoval = true
        await write({ id: '2' })
      }
      return removed
    })

    try {
      await write({ id: '1' })

      await expect(cache.removeTag('remove-race')).resolves.toBe(1)
      del.mockRestore()
      if (!insertedDuringRemoval) {
        await write({ id: '2' })
      }

      expect(await redis.exists('test:tag-remove-race:2')).toBe(1)
      await expect(cache.removeTag('remove-race')).resolves.toBe(1)
      expect(await redis.exists('test:tag-remove-race:2')).toBe(0)
    } finally {
      del.mockRestore()
      await remove({ id: '1' })
      await remove({ id: '2' })
    }
  })

  it('updates tag memberships when data-dependent tags change', async () => {
    let status: 'old' | 'new' = 'old'
    const taggedCache = defineCache('tag-status:{id:string}', async ({ id }) => {
      return new Cache({ id, status }).setExpire(60)
    }, {
      tags: (_params, data) => data ? [`status:${data.status}`] : [],
    })
    const { write, remove } = await cache.loadCache(taggedCache)

    await write({ id: '1' })
    status = 'new'
    await write({ id: '1' })

    await expect(cache.removeTag('status:old')).resolves.toBe(0)
    expect(await redis.exists('test:tag-status:1')).toBe(1)

    await expect(cache.removeTag('status:new')).resolves.toBe(1)
    expect(await redis.exists('test:tag-status:1')).toBe(0)

    await remove({ id: '1' })
  })

  it('keeps tag indexes consistent when concurrent writes choose different tags', async () => {
    const originalEval = redis.eval.bind(redis)
    const firstTagUpdateEntered = createDeferred()
    const releaseFirstTagUpdate = createDeferred()
    let tagUpdates = 0
    const evalSpy = vi.spyOn(redis, 'eval').mockImplementation(async (
      script: string,
      keyCount: number,
      ...keysAndArgs: Array<string | number>
    ) => {
      if (script.includes('REPLACE_CACHE_TAGS')) {
        tagUpdates += 1
        if (tagUpdates === 1) {
          firstTagUpdateEntered.resolve()
          await releaseFirstTagUpdate.promise
        }
      }
      return originalEval(script, keyCount, ...keysAndArgs)
    })
    const statuses: Array<'old' | 'new'> = ['old', 'new']
    const raceCache = defineCache('tag-race:{id:string}', async ({ id }) => {
      return new Cache({ id, status: statuses.shift() ?? 'new' }).setExpire(60)
    }, {
      tags: (_params, data) => data ? [`status:${data.status}`] : [],
    })
    const { write, read, remove } = await cache.loadCache(raceCache)

    try {
      const firstWrite = write({ id: '1' })
      await firstTagUpdateEntered.promise
      const secondWrite = write({ id: '1' })
      await sleep(30)
      releaseFirstTagUpdate.resolve()
      await Promise.all([firstWrite, secondWrite])

      evalSpy.mockRestore()
      const current = await read({ id: '1' })
      const currentStatus = current?.status
      const losingStatus = currentStatus === 'old' ? 'new' : 'old'

      expect(await redis.sismember(`test:tag:status:${currentStatus}`, 'test:tag-race:1')).toBe(1)
      expect(await redis.sismember(`test:tag:status:${losingStatus}`, 'test:tag-race:1')).toBe(0)
      await expect(cache.removeTag(`status:${losingStatus}`)).resolves.toBe(0)
      expect(await redis.exists('test:tag-race:1')).toBe(1)
    } finally {
      releaseFirstTagUpdate.resolve()
      evalSpy.mockRestore()
      await remove({ id: '1' })
    }
  })

  /* ============ loadCache returns correct shape ============ */

  it('loadCache returns all four operations', async () => {
    const ops = await cache.loadCache(testCache)

    expect(ops).toHaveProperty('read')
    expect(ops).toHaveProperty('write')
    expect(ops).toHaveProperty('remove')
    expect(ops).toHaveProperty('has')

    expect(typeof ops.read).toBe('function')
    expect(typeof ops.write).toBe('function')
    expect(typeof ops.remove).toBe('function')
    expect(typeof ops.has).toBe('function')
  })
})
