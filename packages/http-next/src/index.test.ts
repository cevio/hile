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

describe('HttpNext', () => {
  beforeEach(() => {
    loadMock.mockClear()
    listenMock.mockClear()
    useMock.mockClear()
    nextPrepare.mockClear()
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
})
