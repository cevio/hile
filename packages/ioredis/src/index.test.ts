import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import EventEmitter from 'node:events'

// Regular function = can be used with `new`
function MockRedisCtor(this: any, _opts?: any) {
  const ee = new EventEmitter()
  this.disconnect = vi.fn()
  this.set = vi.fn()
  this.get = vi.fn()
  this.on = ee.on.bind(ee)
  this.off = ee.off.bind(ee)
  this.emit = ee.emit.bind(ee)
  process.nextTick(() => this.emit('connect'))
}

let mockRedisImpl = MockRedisCtor

vi.mock('ioredis', () => ({
  default: vi.fn(function (this: any, opts?: any) {
    return mockRedisImpl.call(this, opts)
  }),
}))

describe('@hile/ioredis', () => {
  const origEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    mockRedisImpl = MockRedisCtor
    origEnv.REDIS_HOST = process.env.REDIS_HOST
    origEnv.REDIS_PORT = process.env.REDIS_PORT
    origEnv.REDIS_USERNAME = process.env.REDIS_USERNAME
    origEnv.REDIS_PASSWORD = process.env.REDIS_PASSWORD
    origEnv.REDIS_DB = process.env.REDIS_DB
  })

  afterEach(() => {
    process.env.REDIS_HOST = origEnv.REDIS_HOST
    process.env.REDIS_PORT = origEnv.REDIS_PORT
    process.env.REDIS_USERNAME = origEnv.REDIS_USERNAME
    process.env.REDIS_PASSWORD = origEnv.REDIS_PASSWORD
    process.env.REDIS_DB = origEnv.REDIS_DB
  })

  /* ============ createRedis ============ */

  it('createRedis() 从环境变量读取配置', async () => {
    process.env.REDIS_HOST = 'env-host'
    process.env.REDIS_PORT = '6380'
    process.env.REDIS_DB = '1'

    const { createRedis } = await import('./index.js')
    const redis = await createRedis()
    expect(redis).toBeDefined()
    expect(typeof redis.set).toBe('function')
  })

  it('createRedis(options) 使用传入配置', async () => {
    const { createRedis } = await import('./index.js')
    const redis = await createRedis({ host: 'custom-host', port: 6379 })
    expect(redis).toBeDefined()
    expect(typeof redis.get).toBe('function')
  })

  it('createRedis() 无 options 无 env 时不报错', async () => {
    delete process.env.REDIS_HOST
    delete process.env.REDIS_PORT
    delete process.env.REDIS_DB

    const { createRedis } = await import('./index.js')
    const redis = await createRedis()
    expect(redis).toBeDefined()
  })

  it('createRedis() 连接失败时 reject', async () => {
    mockRedisImpl = function (this: any, _opts?: any) {
      const ee = new EventEmitter()
      this.disconnect = vi.fn()
      this.set = vi.fn()
      this.get = vi.fn()
      this.on = ee.on.bind(ee)
      this.off = ee.off.bind(ee)
      this.emit = ee.emit.bind(ee)
      process.nextTick(() => this.emit('error', new Error('connection refused')))
    }

    const { createRedis } = await import('./index.js')
    await expect(createRedis()).rejects.toThrow('connection refused')
  })

  /* ============ defineService ============ */

  it('默认导出包含 key/fn/flag', async () => {
    const mod = await import('./index.js')
    const svc = mod.default
    expect(svc).toHaveProperty('key')
    expect(svc).toHaveProperty('fn')
    expect(svc).toHaveProperty('flag')
  })

  it('service factory 创建 redis 客户端并注册 disconnect shutdown', async () => {
    const mod = await import('./index.js')
    const svc = mod.default
    let shutdownFn: ((_: any) => any) | undefined
    const redis = await svc.fn((fn: any) => { shutdownFn = fn })

    expect(redis).toBeDefined()
    expect(typeof redis.set).toBe('function')

    await shutdownFn!()
    expect(redis.disconnect).toHaveBeenCalledOnce()
  })
})
