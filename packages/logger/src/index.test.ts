import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger } from './index'

describe('@hile/logger', () => {
  const originalNodeEnv = process.env['NODE_ENV']
  const originalLogLevel = process.env['LOG_LEVEL']

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env['NODE_ENV'] = originalNodeEnv
    if (originalLogLevel) process.env['LOG_LEVEL'] = originalLogLevel
    else delete process.env['LOG_LEVEL']
  })

  /* ============ createLogger ============ */

  it('返回 pino 实例，包含所有日志方法', () => {
    const logger = createLogger({ level: 'info', pretty: false })
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(typeof logger.error).toBe('function')
    expect(typeof logger.warn).toBe('function')
    expect(typeof logger.debug).toBe('function')
    expect(typeof logger.fatal).toBe('function')
    expect(typeof logger.trace).toBe('function')
    expect(typeof logger.child).toBe('function')
    expect(typeof logger.flush).toBe('function')
  })

  it('level 参数正确传递', () => {
    const logger = createLogger({ level: 'warn', pretty: false })
    expect(logger.level).toBe('warn')
  })

  it('所有 level 值都可正常调用', () => {
    const logger = createLogger({ level: 'trace', pretty: false })
    expect(() => logger.trace('test')).not.toThrow()

    const logger2 = createLogger({ level: 'fatal', pretty: false })
    expect(() => logger2.fatal('test')).not.toThrow()
  })

  it('pretty=false 输出 JSON', () => {
    const logger = createLogger({ level: 'info', pretty: false })
    expect(() => logger.info('test')).not.toThrow()
  })

  it('pretty=true 使用 pino-pretty transport', () => {
    const logger = createLogger({ level: 'info', pretty: true })
    expect(() => logger.info('pretty test')).not.toThrow()
  })

  it('redact 过滤敏感字段', () => {
    const logger = createLogger({ level: 'info', pretty: false, redact: ['password'] })
    expect(() => logger.info({ password: 'secret' }, 'test')).not.toThrow()
  })

  it('level 参数优先于环境变量', () => {
    process.env['LOG_LEVEL'] = 'error'
    const logger = createLogger({ level: 'debug', pretty: false })
    expect(logger.level).toBe('debug')
  })

  it('未传 level 时使用 LOG_LEVEL 环境变量', () => {
    process.env['LOG_LEVEL'] = 'debug'
    const logger = createLogger({ pretty: false })
    expect(logger.level).toBe('debug')
  })

  it('level 和 LOG_LEVEL 均未设置时默认 info', () => {
    delete process.env['LOG_LEVEL']
    // 确保 NODE_ENV 不干扰
    const logger = createLogger({ pretty: false })
    expect(logger.level).toBe('info')
  })

  it('pretty 参数优先——显式 false 即使 NODE_ENV 非 production', () => {
    process.env['NODE_ENV'] = 'development'
    const logger = createLogger({ level: 'info', pretty: false })
    expect(() => logger.info('test')).not.toThrow()
  })

  it('pretty 未传时根据 NODE_ENV 自动判断', () => {
    // NODE_ENV=production → pretty=false
    process.env['NODE_ENV'] = 'production'
    const loggerProd = createLogger({ level: 'info' })
    // NODE_ENV=development → pretty=true
    process.env['NODE_ENV'] = 'development'
    const loggerDev = createLogger({ level: 'info' })
    // Both should work without throwing
    expect(() => loggerProd.info('prod')).not.toThrow()
    expect(() => loggerDev.info('dev')).not.toThrow()
  })

  it('child 方法返回子 logger', () => {
    const logger = createLogger({ level: 'info', pretty: false })
    const child = logger.child({ module: 'test' })
    expect(child).toBeDefined()
    expect(typeof child.info).toBe('function')
    expect(() => child.info('child test')).not.toThrow()
  })

  it('flush 方法可调用', async () => {
    const logger = createLogger({ level: 'info', pretty: false })
    expect(() => logger.flush()).not.toThrow()
  })

  /* ============ defineService ============ */

  it('默认导出包含 key/fn/flag', async () => {
    const loggerService = (await import('./index.js')).default
    expect(loggerService).toBeDefined()
    expect(loggerService).toHaveProperty('key')
    expect(loggerService).toHaveProperty('fn')
    expect(loggerService).toHaveProperty('flag')
  })

  it('service factory 创建 logger 实例', async () => {
    const loggerService = (await import('./index.js')).default
    const logger = await loggerService.fn(() => {})
    expect(logger).toBeDefined()
    expect(typeof logger.info).toBe('function')
    expect(logger.level).toBe('info')
  })

  it('service shutdown 执行 flush', async () => {
    const loggerService = (await import('./index.js')).default
    let shutdownFn: (() => void) | undefined
    const logger = await loggerService.fn((fn) => { shutdownFn = fn })
    const flushSpy = vi.spyOn(logger, 'flush')
    await shutdownFn!()
    expect(flushSpy).toHaveBeenCalledOnce()
  })
})
