import { describe, it, expect, vi } from 'vitest'
import FindMyWay from './find-my-way'

describe('FindMyWay 包装器', () => {
  function createRouter() {
    return FindMyWay({
      ignoreDuplicateSlashes: true,
      ignoreTrailingSlash: true,
      maxParamLength: +Infinity,
      allowUnsafeRegex: true,
      caseSensitive: true,
      // @ts-ignore
      defaultRoute: async (_: any, next: any) => {
        await next()
      },
    })
  }

  describe('on - 注册路由', () => {
    it('注册 GET 路由后通过 routes() 中间件可以匹配', async () => {
      const router = createRouter()
      const handler = vi.fn(async (ctx: any) => { ctx.body = 'ok' })
      router.on('GET', '/test', handler)

      const routeMiddleware = router.routes()
      const ctx: any = { method: 'GET', path: '/test' }
      await routeMiddleware(ctx, async () => {})

      expect(handler).toHaveBeenCalled()
      expect(ctx.body).toBe('ok')
    })

    it('注册路由返回实例以支持链式调用', () => {
      const router = createRouter()
      const result = router.on('GET', '/a', async () => {})
      expect(result).toBe(router)
    })
  })

  describe('routes - 生成 Koa 中间件', () => {
    it('匹配的路由设置 ctx.params', async () => {
      const router = createRouter()
      router.on('GET', '/users/:id', async (ctx: any) => {
        ctx.body = ctx.params.id
      })

      const routeMiddleware = router.routes()
      const ctx: any = { method: 'GET', path: '/users/42' }
      await routeMiddleware(ctx, async () => {})

      expect(ctx.params).toEqual({ id: '42' })
      expect(ctx.body).toBe('42')
    })

    it('未匹配的路由走 defaultRoute', async () => {
      const router = createRouter()
      const nextFn = vi.fn()

      const routeMiddleware = router.routes()
      const ctx: any = { method: 'GET', path: '/not-found' }
      await routeMiddleware(ctx, nextFn)

      expect(nextFn).toHaveBeenCalled()
    })

    it('多个中间件按顺序执行（koa-compose）', async () => {
      const router = createRouter()
      const order: number[] = []
      router.on(
        'GET', '/chain',
        async (_ctx: any, next: any) => { order.push(1); await next() },
        async (_ctx: any, next: any) => { order.push(2); await next() },
        async (ctx: any) => { order.push(3); ctx.body = 'done' },
      )

      const routeMiddleware = router.routes()
      const ctx: any = { method: 'GET', path: '/chain' }
      await routeMiddleware(ctx, async () => {})

      expect(order).toEqual([1, 2, 3])
      expect(ctx.body).toBe('done')
    })
  })

  describe('off - 注销路由', () => {
    it('注销后路由不再匹配', async () => {
      const router = createRouter()
      const handler = vi.fn(async (ctx: any) => { ctx.body = 'ok' })
      router.on('GET', '/remove-me', handler)
      router.off('GET', '/remove-me')

      const routeMiddleware = router.routes()
      const ctx: any = { method: 'GET', path: '/remove-me' }
      const nextFn = vi.fn()
      await routeMiddleware(ctx, nextFn)

      expect(handler).not.toHaveBeenCalled()
      expect(nextFn).toHaveBeenCalled()
    })
  })

  describe('prettyPrint - 打印路由树', () => {
    it('返回路由树字符串', () => {
      const router = createRouter()
      router.on('GET', '/a', async () => {})
      router.on('POST', '/b', async () => {})
      const output = router.prettyPrint()
      expect(typeof output).toBe('string')
      expect(output).toContain('a')
      expect(output).toContain('b')
    })
  })
})
