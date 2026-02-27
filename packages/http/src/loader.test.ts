import { describe, it, expect, afterEach } from 'vitest'
import { Http } from './http'
import { Loader } from './loader'
import { defineController } from './controller'

describe('Loader', () => {
  let closeServer: (() => void) | undefined

  afterEach(() => {
    closeServer?.()
    closeServer = undefined
  })

  describe('compile - 单个路由绑定编译', () => {
    it('正确绑定路由并响应请求', async () => {
      const http = new Http({ port: 5001 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'compiled')
      loader.compile('/api/test', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5001/api/test')
      expect(await res.text()).toBe('compiled')
    })

    it('路径不以 / 开头时自动补充', async () => {
      const http = new Http({ port: 5002 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'no-slash')
      loader.compile('api/hello', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5002/api/hello')
      expect(await res.text()).toBe('no-slash')
    })

    it('去除默认后缀 /index', async () => {
      const http = new Http({ port: 5003 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'index-page')
      loader.compile('/api/index', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5003/api')
      expect(await res.text()).toBe('index-page')
    })

    it('路径仅为 /index 时重置为 /', async () => {
      const http = new Http({ port: 5004 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'root')
      loader.compile('/index', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5004/')
      expect(await res.text()).toBe('root')
    })

    it('自定义 defaultSuffix', async () => {
      const http = new Http({ port: 5005 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'custom-suffix')
      loader.compile('/api/home', controller, { defaultSuffix: '/home' })

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5005/api')
      expect(await res.text()).toBe('custom-suffix')
    })

    it('将 [param] 转换为 :param 路由参数', async () => {
      const http = new Http({ port: 5006 })
      const loader = new Loader(http)
      const controller = defineController('GET', (ctx) => `id-${ctx.params.id}`)
      loader.compile('/users/[id]', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5006/users/99')
      expect(await res.text()).toBe('id-99')
    })

    it('支持多个路径参数', async () => {
      const http = new Http({ port: 5007 })
      const loader = new Loader(http)
      const controller = defineController('GET', (ctx) =>
        `${ctx.params.category}-${ctx.params.id}`
      )
      loader.compile('/[category]/[id]', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5007/books/42')
      expect(await res.text()).toBe('books-42')
    })

    it('添加 prefix 前缀', async () => {
      const http = new Http({ port: 5008 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'prefixed')
      loader.compile('/hello', controller, { prefix: '/api/v1' })

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5008/api/v1/hello')
      expect(await res.text()).toBe('prefixed')
    })

    it('接受控制器数组，批量绑定不同方法', async () => {
      const http = new Http({ port: 5009 })
      const loader = new Loader(http)
      const getCtrl = defineController('GET', () => 'get-result')
      const postCtrl = defineController('POST', () => 'post-result')
      loader.compile('/multi', [getCtrl, postCtrl])

      closeServer = await http.listen()

      const getRes = await fetch('http://127.0.0.1:5009/multi')
      expect(await getRes.text()).toBe('get-result')

      const postRes = await fetch('http://127.0.0.1:5009/multi', { method: 'POST' })
      expect(await postRes.text()).toBe('post-result')
    })

    it('返回注销回调，调用后路由不再匹配', async () => {
      const http = new Http({ port: 5010 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'temp')
      const off = loader.compile('/temp', controller)

      closeServer = await http.listen()

      const before = await fetch('http://127.0.0.1:5010/temp')
      expect(await before.text()).toBe('temp')

      off()

      const after = await fetch('http://127.0.0.1:5010/temp')
      expect(after.status).toBe(404)
    })

    it('注销多个控制器绑定（逆序注销）', async () => {
      const http = new Http({ port: 5011 })
      const loader = new Loader(http)
      const getCtrl = defineController('GET', () => 'g')
      const postCtrl = defineController('POST', () => 'p')
      const off = loader.compile('/batch', [getCtrl, postCtrl])

      closeServer = await http.listen()
      off()

      const getRes = await fetch('http://127.0.0.1:5011/batch')
      expect(getRes.status).toBe(404)

      const postRes = await fetch('http://127.0.0.1:5011/batch', { method: 'POST' })
      expect(postRes.status).toBe(404)
    })

    it('controller.data.url 被设置为编译后的路由路径', () => {
      const http = new Http({ port: 5012 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'test')
      loader.compile('/users/[id]', controller, { prefix: '/api' })
      expect(controller.data.url).toBe('/api/users/:id')
    })
  })
})
