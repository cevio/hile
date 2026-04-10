import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createControllerMetadata, defineController, defineResponsePlugin } from './controller'

function mockCtx(overrides: Record<string, unknown> = {}) {
  const ctx: Record<string, unknown> = {
    query: {},
    params: {},
    request: { body: undefined },
    throw(status: number, msg?: string) {
      const err = Object.assign(new Error(msg ?? String(status)), { status })
      throw err
    },
    ...overrides,
  }
  return ctx
}

describe('defineController - 定义路由控制器', () => {
  it('传入 method 和 controller 函数时，正确返回注册信息', () => {
    const fn = vi.fn((ctx) => 'hello')
    const result = defineController('GET', fn)
    expect(result).toHaveProperty('id')
    expect(result.method).toBe('GET')
    expect(result.middlewares).toBeInstanceOf(Array)
    expect(result.middlewares.length).toBe(1)
    expect(result.data).toEqual({})
  })

  it('传入 method、middlewares 数组和 controller 函数时，正确返回注册信息', () => {
    const mw1 = vi.fn()
    const mw2 = vi.fn()
    const fn = vi.fn((ctx) => 'hello')
    const result = defineController('POST', [mw1, mw2], fn)
    expect(result.method).toBe('POST')
    expect(result.middlewares.length).toBe(3)
  })

  it('每次调用分配不同的 id', () => {
    const r1 = defineController('GET', () => 1)
    const r2 = defineController('GET', () => 2)
    expect(r1.id).not.toBe(r2.id)
  })

  it('controller 函数返回值不为 undefined 时设置 ctx.body', async () => {
    const fn = () => ({ message: 'ok' })
    const result = defineController('GET', fn)
    const ctx: any = {}
    await result.middlewares[0](ctx, async () => { })
    expect(ctx.body).toEqual({ message: 'ok' })
  })

  it('controller 函数返回 undefined 时不设置 ctx.body', async () => {
    const fn = () => undefined
    const result = defineController('GET', fn)
    const ctx: any = {}
    await result.middlewares[0](ctx, async () => { })
    expect(ctx.body).toBeUndefined()
  })

  it('controller 函数支持异步', async () => {
    const fn = async () => 'async result'
    const result = defineController('GET', fn)
    const ctx: any = {}
    await result.middlewares[0](ctx, async () => { })
    expect(ctx.body).toBe('async result')
  })

  it('middlewares 不是数组且不是函数时抛出错误', () => {
    expect(() => {
      // @ts-ignore
      defineController('GET', 'not-a-function', () => 'hello')
    }).toThrow('Middlewares must be an array')
  })

  it('没有传入 controller 函数时抛出错误', () => {
    expect(() => {
      // @ts-ignore
      defineController('GET', [])
    }).toThrow('Controller function is required')
  })

  it('传入空 middlewares 数组和 controller 函数时，middlewares 包含一个处理函数', () => {
    const fn = () => 'test'
    const result = defineController('GET', [], fn)
    expect(result.middlewares.length).toBe(1)
  })

  it('自定义中间件在 controller 之前执行', async () => {
    const order: number[] = []
    const mw = async (_ctx: any, next: any) => { order.push(1); await next() }
    const fn = () => { order.push(2); return 'done' }
    const result = defineController('GET', [mw], fn)

    const ctx: any = {}
    for (const middleware of result.middlewares) {
      await middleware(ctx, async () => { })
    }
    expect(order).toEqual([1, 2])
  })

  describe('createControllerMetadata + Zod', () => {
    it('校验 query 通过后注入解析结果', async () => {
      const meta = createControllerMetadata({
        method: 'GET',
        middlewares: [],
        schema: { query: z.object({ page: z.coerce.number() }) },
      })
      const result = defineController(meta, (ctx) => ({ n: ctx.query.page }))
      const ctx = mockCtx({ query: { page: '3' } })
      const composed = result.middlewares[result.middlewares.length - 1]
      await composed(ctx as any, async () => { })
      expect(ctx.body).toEqual({ n: 3 })
    })

    it('query 校验失败时 ctx.throw(400)', async () => {
      const meta = createControllerMetadata({
        method: 'GET',
        middlewares: [],
        schema: { query: z.object({ id: z.string().uuid() }) },
      })
      const result = defineController(meta, () => ({ ok: true }))
      const ctx = mockCtx({ query: { id: 'not-uuid' } })
      const composed = result.middlewares[result.middlewares.length - 1]
      await expect(composed(ctx as any, async () => { })).rejects.toMatchObject({ status: 400 })
    })

    it('仅 body schema 时也会校验 body', async () => {
      const meta = createControllerMetadata({
        method: 'POST',
        middlewares: [],
        schema: { body: z.object({ name: z.string().min(1) }) },
      })
      const result = defineController(meta, (ctx) => ctx.request.body)
      const ctx = mockCtx({ request: { body: { name: 'a' } } })
      const composed = result.middlewares[result.middlewares.length - 1]
      await composed(ctx as any, async () => { })
      expect(ctx.body).toEqual({ name: 'a' })
    })

    it('params 校验失败时 ctx.throw(400)', async () => {
      const meta = createControllerMetadata({
        method: 'GET',
        middlewares: [],
        schema: { params: z.object({ id: z.coerce.number().positive() }) },
      })
      const result = defineController(meta, () => ({ ok: true }))
      const ctx = mockCtx({ params: { id: '-1' } })
      const composed = result.middlewares[result.middlewares.length - 1]
      await expect(composed(ctx as any, async () => { })).rejects.toMatchObject({ status: 400 })
    })
  })

  it('response plugin 可以修改最终 ctx.body', async () => {
    defineResponsePlugin(async (_ctx, result, next) => {
      return await next({ wrapped: result })
    })

    const result = defineController('GET', () => ({ message: 'ok' }))
    const ctx: any = {}
    await result.middlewares[0](ctx, async () => { })

    expect(ctx.body).toEqual({ wrapped: { message: 'ok' } })
  })
})
