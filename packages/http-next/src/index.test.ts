import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Server } from 'node:http'

const { loadMock, listenMock, useMock } = vi.hoisted(() => ({
  loadMock: vi.fn().mockResolvedValue(undefined),
  listenMock: vi.fn(async (onListen?: (server: Server) => void | Promise<void>) => {
    if (onListen) await onListen({} as Server)
    return async () => {}
  }),
  useMock: vi.fn(),
}))

vi.mock('@hile/http', () => ({
  Http: class {
    use = useMock
    load = loadMock
    listen = listenMock
  },
}))

vi.mock('koa-static', () => ({
  default: vi.fn(() => {
    return async () => {}
  }),
}))

const nextPrepare = vi.fn().mockResolvedValue(undefined)
const nextGetRequestHandler = vi.fn(() => () => {})

vi.mock('next', () => ({
  default: vi.fn(() => ({
    prepare: nextPrepare,
    getRequestHandler: nextGetRequestHandler,
  })),
}))

import { HttpNext } from './index'
import NextServer from 'next'

describe('HttpNext', () => {
  beforeEach(() => {
    loadMock.mockClear()
    listenMock.mockClear()
    useMock.mockClear()
    nextPrepare.mockClear()
    NextServer.mockClear()
  })

  it('start() 默认从 cwd/src/controllers 加载控制器，prefix /-、suffix controller、conflict error', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/proj',
    })
    await httpNext.start()

    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(loadMock).toHaveBeenCalledWith(
      '/proj/src/controllers',
      expect.objectContaining({
        suffix: 'controller',
        defaultSuffix: '/index',
        prefix: '/-',
        conflict: 'error',
      }),
    )
  })

  it('生产模式从 cwd/dist/controllers 加载', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/myapp',
    })
    await httpNext.start()

    expect(loadMock).toHaveBeenCalledWith(
      '/myapp/dist/controllers',
      expect.objectContaining({
        conflict: 'error',
      }),
    )
  })

  it('可配置 controllerDirectory、controllerPrefix、controllerSuffix', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/p',
      controllerDirectory: 'app',
      controllerPrefix: '/api',
      controllerSuffix: 'api',
    })
    await httpNext.start()

    expect(loadMock).toHaveBeenCalledWith(
      '/p/src/app',
      expect.objectContaining({
        suffix: 'api',
        prefix: '/api',
        conflict: 'error',
      }),
    )
  })

  it('publicPath 传递给 koa-static 中间件', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/proj',
      publicPath: 'public',
    })
    expect(useMock).toHaveBeenCalled()
  })

  it('publicPath 支持数组', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/proj',
      publicPath: ['public', 'assets'],
    })
    expect(useMock).toHaveBeenCalledTimes(2)
  })

  it('use() 委托给底层 http.use', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj' })
    const mw = async () => {}
    httpNext.use(mw)
    expect(useMock).toHaveBeenCalledWith(mw)
  })

  it('load() 委托给 http.load 并返回结果', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj' })
    httpNext.load('/custom/path')
    expect(loadMock).toHaveBeenCalledWith(
      '/custom/path',
      expect.objectContaining({
        suffix: 'controller',
        defaultSuffix: '/index',
        prefix: '/-',
        conflict: 'error',
      }),
    )
  })

  it('onListen 在 start 中被调用', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj' })
    const onListenSpy = vi.fn()
    await httpNext.start(onListenSpy)
    expect(onListenSpy).toHaveBeenCalled()
  })

  it('specialControllers 在主 load 之后追加多次 http.load', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/proj',
      specialControllers: [
        { directory: 'admin-api', prefix: '/admin' },
        { directory: 'legacy', prefix: '/v1' },
      ],
    })
    await httpNext.start()

    expect(loadMock).toHaveBeenCalledTimes(3)
    expect(loadMock).toHaveBeenNthCalledWith(
      1,
      '/proj/src/controllers',
      expect.objectContaining({
        prefix: '/-',
        conflict: 'error',
      }),
    )
    expect(loadMock).toHaveBeenNthCalledWith(
      2,
      '/proj/src/admin-api',
      expect.objectContaining({
        prefix: '/admin',
        conflict: 'error',
      }),
    )
    expect(loadMock).toHaveBeenNthCalledWith(
      3,
      '/proj/src/legacy',
      expect.objectContaining({
        prefix: '/v1',
        conflict: 'error',
      }),
    )
  })

  it('生产模式下 specialControllers 从 dist 加载', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/proj',
      specialControllers: [
        { directory: 'admin-api', prefix: '/admin' },
      ],
    })
    await httpNext.start()

    expect(loadMock).toHaveBeenCalledWith(
      '/proj/dist/admin-api',
      expect.objectContaining({ prefix: '/admin' }),
    )
  })

  it('不传 cwd 时默认使用 process.cwd()', () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({ port: 3000 })
    expect(httpNext.cwd).toBe(process.cwd())
  })

  it('生产模式下 nextArtifactsDir 为当前目录时 distDir 为 .next', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj', nextArtifactsDir: '/proj' })
    await httpNext.start()
    expect(NextServer).toHaveBeenCalledWith(expect.objectContaining({
      conf: { distDir: '.next' },
    }))
  })

  it('生产模式默认不传 conf.distDir', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj' })
    await httpNext.start()
    expect(NextServer.mock.calls.at(-1)![0]).not.toHaveProperty('conf')
  })

  it('生产模式下自定义 nextArtifactsDir 时传递 conf.distDir', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const httpNext = new HttpNext({
      port: 3000,
      cwd: '/myapp',
      nextArtifactsDir: 'custom-next-dir',
    })
    await httpNext.start()

    expect(NextServer).toHaveBeenCalledWith(expect.objectContaining({
      dev: false,
      dir: '/myapp',
      conf: { distDir: expect.any(String) },
    }))
  })

  it('forwardToNextMiddleware 设置 ctx.respond=false 和 ctx.status=200', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const httpNext = new HttpNext({ port: 3000, cwd: '/proj' })
    await httpNext.start()

    // start() 中第二个 use 调用是 createForwardToNextMiddleware 返回的中间件
    const middleware = useMock.mock.calls[1][0]
    const ctx: any = { respond: true, status: 404, req: {}, res: {} }
    await middleware(ctx)

    expect(ctx.respond).toBe(false)
    expect(ctx.status).toBe(200)
  })
})
