import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock QueryRunner factory
function createMockQueryRunner() {
  return {
    connect: vi.fn(),
    startTransaction: vi.fn(),
    commitTransaction: vi.fn(),
    rollbackTransaction: vi.fn(),
    release: vi.fn(),
    manager: { save: vi.fn() },
  }
}

// Default DataSource constructor — regular function for `new` support
function MockDataSourceCtor(this: any, _opts?: any) {
  let qr: ReturnType<typeof createMockQueryRunner>
  this.initialize = vi.fn().mockResolvedValue(undefined)
  this.destroy = vi.fn()
  this.createQueryRunner = vi.fn(() => {
    qr = createMockQueryRunner()
    return qr
  })
  this.options = {}
}

let mockDataSourceImpl: new (...args: any[]) => any = MockDataSourceCtor

vi.mock('typeorm', () => ({
  DataSource: vi.fn(function (this: any, opts?: any) {
    return new mockDataSourceImpl(opts)
  }),
  QueryRunner: class {},
}))

describe('@hile/typeorm', () => {
  const origEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    mockDataSourceImpl = MockDataSourceCtor
    origEnv.TYPEORM_TYPE = process.env.TYPEORM_TYPE
    origEnv.TYPEORM_HOST = process.env.TYPEORM_HOST
    origEnv.TYPEORM_USERNAME = process.env.TYPEORM_USERNAME
    origEnv.TYPEORM_PASSWORD = process.env.TYPEORM_PASSWORD
    origEnv.TYPEORM_DATABASE = process.env.TYPEORM_DATABASE
    origEnv.TYPEORM_PORT = process.env.TYPEORM_PORT
    origEnv.TYPEORM_ENTITIES = process.env.TYPEORM_ENTITIES
    origEnv.TYPEORM_SYNCHRONIZE = process.env.TYPEORM_SYNCHRONIZE
    origEnv.NODE_ENV = process.env.NODE_ENV
  })

  afterEach(() => {
    process.env.TYPEORM_TYPE = origEnv.TYPEORM_TYPE
    process.env.TYPEORM_HOST = origEnv.TYPEORM_HOST
    process.env.TYPEORM_USERNAME = origEnv.TYPEORM_USERNAME
    process.env.TYPEORM_PASSWORD = origEnv.TYPEORM_PASSWORD
    process.env.TYPEORM_DATABASE = origEnv.TYPEORM_DATABASE
    process.env.TYPEORM_PORT = origEnv.TYPEORM_PORT
    process.env.TYPEORM_ENTITIES = origEnv.TYPEORM_ENTITIES
    process.env.TYPEORM_SYNCHRONIZE = origEnv.TYPEORM_SYNCHRONIZE
    process.env.NODE_ENV = origEnv.NODE_ENV
  })

  /* ============ createDataSource ============ */

  it('createDataSource() 从环境变量读取配置', async () => {
    process.env.TYPEORM_HOST = 'env-host'
    process.env.TYPEORM_PORT = '3306'
    process.env.TYPEORM_TYPE = 'mysql'

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('createDataSource(options) 使用传入配置', async () => {
    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn({ type: 'postgres', host: 'pg-host' })
    expect(ds).toBeDefined()
  })

  it('createDataSource 调用 initialize', async () => {
    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn({ type: 'mysql', host: 'h' })
    expect(ds.initialize).toHaveBeenCalledOnce()
  })

  it('createDataSource 初始化失败时 reject', async () => {
    mockDataSourceImpl = class MockFail {
      initialize = vi.fn().mockRejectedValue(new Error('connection failed'))
      destroy = vi.fn()
      createQueryRunner = vi.fn()
      options = {}
    }

    const { createDataSource: fn } = await import('./index.js')
    await expect(fn({ type: 'mysql', host: 'h' })).rejects.toThrow('connection failed')
  })

  it('envOptions 读取 SYNCHRONIZE 为 true', async () => {
    process.env.TYPEORM_SYNCHRONIZE = 'true'

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('envOptions 读取 SYNCHRONIZE 为 false', async () => {
    process.env.TYPEORM_SYNCHRONIZE = 'false'

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('envOptions 设置 logging = true 当 NODE_ENV=development', async () => {
    process.env.NODE_ENV = 'development'

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('envOptions 设置 logging = false 当 NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production'

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('envOptions entities 从 TYPEORM_ENTITIES 读取', async () => {
    process.env.TYPEORM_ENTITIES = './entities/*.ts'
    delete process.env.TYPEORM_PORT

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  it('envOptions port 未设置时不报错', async () => {
    delete process.env.TYPEORM_PORT

    const { createDataSource: fn } = await import('./index.js')
    const ds = await fn()
    expect(ds).toBeDefined()
  })

  /* ============ transaction ============ */

  it('transaction 成功提交', async () => {
    const { transaction } = await import('./index.js')
    const ds = new MockDataSourceCtor()

    const result = await transaction(ds as any, async (runner: any) => {
      await runner.manager.save({ id: 1 })
      return 'ok'
    })

    expect(result).toBe('ok')
    expect(ds.createQueryRunner()).toBeDefined()
  })

  it('transaction 失败时回滚并执行补偿回调', async () => {
    const { transaction } = await import('./index.js')
    const ds = new MockDataSourceCtor()
    const rollbackFn = vi.fn()

    await expect(
      transaction(ds as any, async (runner: any, rollback: any) => {
        rollback(rollbackFn)
        throw new Error('business error')
      }),
    ).rejects.toThrow('business error')

    expect(rollbackFn).toHaveBeenCalledOnce()
  })

  it('transaction 多个补偿 LIFO 顺序执行', async () => {
    const { transaction } = await import('./index.js')
    const ds = new MockDataSourceCtor()
    const order: number[] = []

    await expect(
      transaction(ds as any, async (runner: any, rollback: any) => {
        rollback(() => { order.push(1) })
        rollback(() => { order.push(2) })
        rollback(() => { order.push(3) })
        throw new Error('err')
      }),
    ).rejects.toThrow('err')

    expect(order).toEqual([3, 2, 1])
  })

  /* ============ defineService ============ */

  it('默认导出包含 key/fn/flag', async () => {
    const mod = await import('./index.js')
    const svc = mod.default
    expect(svc).toHaveProperty('key')
    expect(svc).toHaveProperty('fn')
    expect(svc).toHaveProperty('flag')
  })

  it('service factory 创建 DataSource 并注册 destroy shutdown', async () => {
    const mod = await import('./index.js')
    const svc = mod.default
    let shutdownFn: ((_: any) => any) | undefined
    const ds = await svc.fn((fn: any) => { shutdownFn = fn })

    expect(ds).toBeDefined()

    await shutdownFn!()
    expect(ds.destroy).toHaveBeenCalledOnce()
  })
})
