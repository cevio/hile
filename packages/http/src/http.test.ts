import { describe, it, expect, afterEach } from 'vitest'
import { Http } from './http'

describe('Http - HTTP 服务类', () => {
  let closeServer: (() => void) | undefined

  afterEach(() => {
    closeServer?.()
    closeServer = undefined
  })

  describe('constructor', () => {
    it('设置端口号', () => {
      const http = new Http({ port: 3000 })
      expect(http.port).toBe(3000)
    })

    it('未传 keys 时自动生成', () => {
      const http = new Http({ port: 3001 })
      expect(http.port).toBe(3001)
    })

    it('传入自定义 keys', () => {
      const http = new Http({ port: 3002, keys: ['key1', 'key2'] })
      expect(http.port).toBe(3002)
    })
  })

  describe('use - 注册中间件', () => {
    it('返回 this 以支持链式调用', () => {
      const http = new Http({ port: 3010 })
      const result = http.use(async (_ctx, next) => { await next() })
      expect(result).toBe(http)
    })

    it('支持连续链式注册多个中间件', () => {
      const http = new Http({ port: 3011 })
      const result = http
        .use(async (_ctx, next) => { await next() })
        .use(async (_ctx, next) => { await next() })
        .use(async (_ctx, next) => { await next() })
      expect(result).toBe(http)
    })
  })

  describe('route - 注册路由', () => {
    it('注册路由返回注销回调函数', () => {
      const http = new Http({ port: 3020 })
      const off = http.route('GET', '/test', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })
  })

  describe('get/post/put/delete/trace - HTTP 方法快捷注册', () => {
    it('get() 返回注销回调函数', () => {
      const http = new Http({ port: 3030 })
      const off = http.get('/path', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })

    it('post() 返回注销回调函数', () => {
      const http = new Http({ port: 3031 })
      const off = http.post('/path', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })

    it('put() 返回注销回调函数', () => {
      const http = new Http({ port: 3032 })
      const off = http.put('/path', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })

    it('delete() 返回注销回调函数', () => {
      const http = new Http({ port: 3033 })
      const off = http.delete('/path', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })

    it('trace() 返回注销回调函数', () => {
      const http = new Http({ port: 3034 })
      const off = http.trace('/path', async (ctx) => { ctx.body = 'ok' })
      expect(typeof off).toBe('function')
    })
  })

  describe('listen - 启动服务', () => {
    it('启动后返回 close 回调函数', async () => {
      const http = new Http({ port: 4001 })
      closeServer = await http.listen()
      expect(typeof closeServer).toBe('function')
    })

    it('启动后调用 onListen 回调', async () => {
      const http = new Http({ port: 4002 })
      let serverRef: any = null
      closeServer = await http.listen((server) => {
        serverRef = server
      })
      expect(serverRef).not.toBeNull()
      expect(serverRef).toHaveProperty('listen')
    })

    it('启动后可以接收 HTTP 请求', async () => {
      const http = new Http({ port: 4003 })
      http.get('/hello', async (ctx) => { ctx.body = 'world' })
      closeServer = await http.listen()

      const res = await fetch('http://127.0.0.1:4003/hello')
      const text = await res.text()
      expect(res.status).toBe(200)
      expect(text).toBe('world')
    })

    it('支持多个路由方法', async () => {
      const http = new Http({ port: 4004 })
      http.get('/data', async (ctx) => { ctx.body = 'get' })
      http.post('/data', async (ctx) => { ctx.body = 'post' })
      closeServer = await http.listen()

      const getRes = await fetch('http://127.0.0.1:4004/data')
      expect(await getRes.text()).toBe('get')

      const postRes = await fetch('http://127.0.0.1:4004/data', { method: 'POST' })
      expect(await postRes.text()).toBe('post')
    })

    it('注销路由后不再匹配', async () => {
      const http = new Http({ port: 4005 })
      const off = http.get('/removable', async (ctx) => { ctx.body = 'exists' })
      closeServer = await http.listen()

      const before = await fetch('http://127.0.0.1:4005/removable')
      expect(await before.text()).toBe('exists')

      off()

      const after = await fetch('http://127.0.0.1:4005/removable')
      expect(after.status).toBe(404)
    })

    it('中间件按注册顺序执行', async () => {
      const http = new Http({ port: 4006 })
      const order: number[] = []
      http.use(async (_ctx, next) => { order.push(1); await next() })
      http.use(async (_ctx, next) => { order.push(2); await next() })
      http.get('/order', async (ctx) => { order.push(3); ctx.body = 'ok' })
      closeServer = await http.listen()

      await fetch('http://127.0.0.1:4006/order')
      expect(order).toEqual([1, 2, 3])
    })

    it('路由支持路径参数', async () => {
      const http = new Http({ port: 4007 })
      http.get('/users/:id', async (ctx) => {
        ctx.body = `user-${ctx.params.id}`
      })
      closeServer = await http.listen()

      const res = await fetch('http://127.0.0.1:4007/users/123')
      expect(await res.text()).toBe('user-123')
    })

    it('路由支持多个中间件', async () => {
      const http = new Http({ port: 4008 })
      http.get(
        '/multi',
        async (ctx, next) => { ctx.state.step = 1; await next() },
        async (ctx) => { ctx.body = `step-${ctx.state.step}` },
      )
      closeServer = await http.listen()

      const res = await fetch('http://127.0.0.1:4008/multi')
      expect(await res.text()).toBe('step-1')
    })
  })
})
