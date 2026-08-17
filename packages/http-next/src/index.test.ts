import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import { EventEmitter } from 'node:events'

const lifecycle: string[] = []
const closeAllConnections = vi.fn()
const server = Object.assign(new EventEmitter(), {
  listen: vi.fn(),
  closeAllConnections,
}) as unknown as Server
const closeHttpMock = vi.fn(async () => {
  lifecycle.push('http:closed')
})
const loadMock = vi.fn().mockResolvedValue(undefined)
const useMock = vi.fn((middleware: unknown) => {
  lifecycle.push('http:use')
  return middleware
})
const listenMock = vi.fn(async (prepare?: (server: Server) => void | Promise<void>) => {
  lifecycle.push('http:server-created')
  if (prepare) await prepare(server)
  lifecycle.push('http:callback-created')
  lifecycle.push('http:listening')
  return closeHttpMock
})

vi.mock('@hile/http', () => ({
  Http: class {
    use = useMock
    load = loadMock
    listen = listenMock
  },
}))

const nextPrepare = vi.fn(async () => {
  lifecycle.push('next:prepared')
})
const nextClose = vi.fn(async () => {
  lifecycle.push('next:closed')
})
const nextHandler = vi.fn(async () => {})
const nextGetRequestHandler = vi.fn(() => nextHandler)

vi.mock('next', () => ({
  default: vi.fn(() => ({
    prepare: nextPrepare,
    close: nextClose,
    getRequestHandler: nextGetRequestHandler,
  })),
}))

import NextServer from 'next'
import { getHttpNextRequestSignal, HttpNext } from './index'

describe('HttpNext', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'development')
    lifecycle.length = 0
    loadMock.mockClear()
    useMock.mockClear()
    listenMock.mockClear()
    closeHttpMock.mockClear()
    nextPrepare.mockClear()
    nextClose.mockClear()
    nextHandler.mockClear()
    nextGetRequestHandler.mockClear()
    NextServer.mockClear()
    closeAllConnections.mockClear()
    server.removeAllListeners('upgrade')
  })

  it('开发模式按约定加载 cwd/src/controllers 到 /-', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await app.start()

    expect(loadMock).toHaveBeenCalledOnce()
    expect(loadMock).toHaveBeenCalledWith('/proj/src/controllers', {
      suffix: 'controller',
      defaultSuffix: '/index',
      prefix: '/-',
      conflict: 'error',
    })
  })

  it('生产模式按约定加载 cwd/dist/controllers', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await app.start()

    expect(loadMock).toHaveBeenCalledWith(
      '/proj/dist/controllers',
      expect.objectContaining({ prefix: '/-' }),
    )
  })

  it('不传 cwd 时从 process.cwd() 加载默认控制器', async () => {
    const app = new HttpNext({ port: 3000 })

    await app.start()

    expect(loadMock).toHaveBeenCalledWith(
      `${process.cwd()}/src/controllers`,
      expect.objectContaining({ prefix: '/-' }),
    )
  })

  it('use() 委托给内部 Http 并保持链式 API', () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const middleware = async () => {}

    const result = app.use(middleware)

    expect(result).toBe(app)
    expect(useMock).toHaveBeenCalledWith(middleware)
  })

  it('load() 使用固定控制器约定加载显式目录', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await app.load('/external/controllers')

    expect(loadMock).toHaveBeenCalledWith('/external/controllers', {
      suffix: 'controller',
      defaultSuffix: '/index',
      prefix: '/-',
      conflict: 'error',
    })
  })

  it('在冻结 Koa callback 前注册 Next fallback', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await app.start()

    expect(lifecycle.indexOf('http:use')).toBeLessThan(lifecycle.indexOf('http:callback-created'))
  })

  it('准备 Next 后才监听，并在监听完成后调用 onReady', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const onReady = vi.fn(() => lifecycle.push('ready'))

    await app.start(onReady)

    expect(lifecycle).toEqual([
      'http:server-created',
      'next:prepared',
      'http:use',
      'http:callback-created',
      'http:listening',
      'ready',
    ])
    expect(onReady).toHaveBeenCalledWith(server)
  })

  it('将同一个 Node server 交给 Next 且不覆盖 next.config', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await app.start()

    expect(NextServer).toHaveBeenCalledWith({
      dev: false,
      httpServer: server,
      dir: '/proj',
    })
  })

  it('fallback 将原始请求响应交给 Next handler', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()
    const fallback = useMock.mock.calls[0][0]
    const ctx: any = { respond: true, status: 404, req: {}, res: {} }

    await fallback(ctx)

    expect(ctx.respond).toBe(false)
    expect(ctx.status).toBe(200)
    expect(nextHandler).toHaveBeenCalledWith(ctx.req, ctx.res)
  })

  it('在 Next 请求上下文中暴露同一个未中止信号', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()
    const fallback = useMock.mock.calls[0][0]
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    nextHandler.mockImplementationOnce(async () => {
      const signal = getHttpNextRequestSignal()
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(signal!.aborted).toBe(false)
    })

    await fallback({ respond: true, status: 404, req, res })
  })

  it('客户端断开响应连接时中止 Next 请求信号', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()
    const fallback = useMock.mock.calls[0][0]
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    let requestSignal: AbortSignal | undefined
    let release!: () => void
    nextHandler.mockImplementationOnce(async () => {
      requestSignal = getHttpNextRequestSignal()
      await new Promise<void>((resolve) => { release = resolve })
    })

    const pending = fallback({ respond: true, status: 404, req, res })
    await vi.waitFor(() => expect(requestSignal).toBeDefined())
    res.emit('close')
    expect(requestSignal!.aborted).toBe(true)
    release()
    await pending
  })

  it('正常完成响应会清理监听器且不会中止信号', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()
    const fallback = useMock.mock.calls[0][0]
    const req = new EventEmitter()
    const res = Object.assign(new EventEmitter(), { writableEnded: false })
    let requestSignal: AbortSignal | undefined
    nextHandler.mockImplementationOnce(async () => { requestSignal = getHttpNextRequestSignal() })

    await fallback({ respond: true, status: 404, req, res })
    res.writableEnded = true
    res.emit('finish')
    res.emit('close')

    expect(requestSignal!.aborted).toBe(false)
    expect(req.listenerCount('aborted')).toBe(0)
    expect(res.listenerCount('finish')).toBe(0)
    expect(res.listenerCount('close')).toBe(0)
  })

  it('stop 同时完成 HTTP drain 与 Next cleanup，且重复调用安全', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    await stop()
    await stop()

    expect(closeHttpMock).toHaveBeenCalledOnce()
    expect(nextClose).toHaveBeenCalledOnce()
  })

  it('HTTP drain 被升级连接阻塞时仍立即启动 Next cleanup', async () => {
    let releaseHttp!: () => void
    closeHttpMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseHttp = resolve
    }))
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    const stopping = stop()
    await vi.waitFor(() => expect(nextClose).toHaveBeenCalledOnce())
    expect(closeHttpMock).toHaveBeenCalledOnce()

    releaseHttp()
    await stopping
  })

  it('停止时只终止已升级连接，使 HTTP drain 可以完成', async () => {
    const upgradedSocket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    })
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()
    server.emit('upgrade', {}, upgradedSocket)

    await stop()

    expect(upgradedSocket.destroy).toHaveBeenCalledOnce()
    expect(closeAllConnections).toHaveBeenCalledOnce()
  })

  it('生产环境保留普通 HTTP 连接的优雅排空', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    await stop()

    expect(closeAllConnections).not.toHaveBeenCalled()
  })

  it('停止开始后到达的升级连接会被立即拒绝', async () => {
    let releaseHttp!: () => void
    closeHttpMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseHttp = resolve
    }))
    const upgradedSocket = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
    })
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    const stopping = stop()
    server.emit('upgrade', {}, upgradedSocket)

    expect(upgradedSocket.destroy).toHaveBeenCalledOnce()
    releaseHttp()
    await stopping
  })

  it('onReady 回滚时也不会让 HTTP drain 阻止 Next cleanup', async () => {
    let releaseHttp!: () => void
    closeHttpMock.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseHttp = resolve
    }))
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    const starting = app.start(async () => {
      throw new Error('ready failed')
    })
    await vi.waitFor(() => expect(nextClose).toHaveBeenCalledOnce())
    releaseHttp()

    await expect(starting).rejects.toThrow('ready failed')
  })

  it('HTTP drain 失败时仍关闭 Next runtime 并保留原错误', async () => {
    closeHttpMock.mockRejectedValueOnce(new Error('drain failed'))
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    await expect(stop()).rejects.toThrow('drain failed')

    expect(nextClose).toHaveBeenCalledOnce()
  })

  it('HTTP drain 与 Next cleanup 都失败时保留全部错误', async () => {
    const drainError = new Error('drain failed')
    const nextError = new Error('next cleanup failed')
    closeHttpMock.mockRejectedValueOnce(drainError)
    nextClose.mockRejectedValueOnce(nextError)
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    const stop = await app.start()

    await expect(stop()).rejects.toMatchObject({ errors: [drainError, nextError] })
  })

  it('拒绝重复启动同一个实例', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()

    await expect(app.start()).rejects.toThrow('HttpNext has already started')
  })

  it('启动后拒绝继续注册中间件或控制器', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })
    await app.start()

    expect(() => app.use(async () => {})).toThrow('HttpNext has already started')
    expect(() => app.load('/late/controllers')).toThrow('HttpNext has already started')
  })

  it('onReady 失败时关闭已监听的 HTTP server 和 Next runtime', async () => {
    const app = new HttpNext({ port: 3000, cwd: '/proj' })

    await expect(app.start(async () => {
      throw new Error('ready failed')
    })).rejects.toThrow('ready failed')

    expect(closeHttpMock).toHaveBeenCalledOnce()
    expect(nextClose).toHaveBeenCalledOnce()
  })
})
