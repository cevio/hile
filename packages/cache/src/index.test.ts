import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { RedisCache, defineCache, Cache } from './index'
import { loadService } from '@hile/core'
import ioredisService from '@hile/ioredis'

describe('@hile/cache', () => {
  const cache = new RedisCache('test:')
  let redis: Awaited<ReturnType<typeof loadService<typeof ioredisService>>>

  const testCache = defineCache('key:{id:string}', async ({ id }) => {
    return new Cache({ id, value: `hello-${id}` }).setExpire(60)
  })

  beforeAll(async () => {
    redis = await loadService(ioredisService)
  })

  afterAll(async () => {
    // Clean up all test keys
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

    // Verify directly in Redis
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
      return new Cache(`perm-${id}`) // expire默认为0
    })
    const { write, remove } = await cache.loadCache(permCache)

    await write({ id: '1' })

    const ttl = await redis.ttl('test:perm:1')
    // ioredis returns -1 for no TTL, -2 for non-existent
    expect(ttl).toBe(-1)

    await remove({ id: '1' })
  })

  it('write with undefined data on existing key deletes it', async () => {
    const { write, remove: removeOld } = await cache.loadCache(testCache)

    // First write valid data
    await write({ id: '1' })
    expect(await redis.exists('test:key:1')).toBe(1)

    // Now write undefined — should delete
    const undefCache = defineCache('key:{id:string}', async () => new Cache(undefined))
    const { write: writeUndef } = await cache.loadCache(undefCache)
    await writeUndef({ id: '1' })

    expect(await redis.exists('test:key:1')).toBe(0)
  })

  it('write with undefined data on non-existent key does nothing', async () => {
    const undefCache = defineCache('noop:{id:string}', async () => new Cache(undefined))
    const { write } = await cache.loadCache(undefCache)

    // Should not throw
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
    const prefixed = new RedisCache('custom-prefix:')
    const { write, read, remove } = await prefixed.loadCache(testCache)

    await write({ id: '1' })

    // Key exists under prefixed namespace
    expect(await redis.exists('custom-prefix:key:1')).toBe(1)
    // Key does NOT exist under default namespace
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

    // Verify the actual Redis key
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
      return null as any
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
