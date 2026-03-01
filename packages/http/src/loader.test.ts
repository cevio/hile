import { describe, it, expect, afterEach, vi } from 'vitest'
import { Http } from './http'
import { Loader, compileRoutePath, toRouterPath } from './loader'
import { defineController } from './controller'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Loader', () => {
  let closeServer: (() => void) | undefined

  afterEach(() => {
    closeServer?.()
    closeServer = undefined
  })

  describe('pure utils', () => {
    it('compileRoutePath: 规范化路径并处理默认后缀与前缀', () => {
      expect(compileRoutePath('api/index')).toBe('/api')
      expect(compileRoutePath('/index')).toBe('/')
      expect(compileRoutePath('/users/home', { defaultSuffix: '/home' })).toBe('/users')
      expect(compileRoutePath('/users', { prefix: '/api' })).toBe('/api/users')
    })

    it('toRouterPath: 将 [param] 转为 :param', () => {
      expect(toRouterPath('/users/[id]')).toBe('/users/:id')
      expect(toRouterPath('/[category]/[id]')).toBe('/:category/:id')
    })
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

    it('冲突策略=error：重复 method+path 时抛错', () => {
      const http = new Http({ port: 5013 })
      const loader = new Loader(http)
      loader.compile('/conflict', defineController('GET', () => 'a'))
      expect(() => loader.compile('/conflict', defineController('GET', () => 'b')))
        .toThrow('route conflict: GET:/conflict')
    })

    it('冲突策略=warn：保留旧路由并输出警告', async () => {
      const http = new Http({ port: 5014 })
      const loader = new Loader(http)
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { })

      loader.compile('/warn', defineController('GET', () => 'old'))
      loader.compile('/warn', defineController('GET', () => 'new'), { conflict: 'warn' })

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5014/warn')
      expect(await res.text()).toBe('old')
      expect(warnSpy).toHaveBeenCalledOnce()

      warnSpy.mockRestore()
    })

    it('冲突策略=override：新路由覆盖旧路由', async () => {
      const http = new Http({ port: 5015 })
      const loader = new Loader(http)

      loader.compile('/override', defineController('GET', () => 'old'))
      loader.compile('/override', defineController('GET', () => 'new'), { conflict: 'override' })

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5015/override')
      expect(await res.text()).toBe('new')
    })

    it('onConflict 回调可获得冲突上下文', () => {
      const http = new Http({ port: 5016 })
      const loader = new Loader(http)
      const onConflict = vi.fn()

      loader.compile('/hook', defineController('GET', () => 'old'))
      loader.compile('/hook', defineController('GET', () => 'new'), { conflict: 'warn', onConflict })

      expect(onConflict).toHaveBeenCalledWith({
        routeKey: 'GET:/hook',
        method: 'GET',
        url: '/hook',
        strategy: 'warn',
        resolution: 'keep',
      })
    })
  })

  describe('from - 文件系统加载', () => {
    it('非法默认导出时错误信息包含文件路径与导出摘要', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'bad'), { recursive: true })
        const file = join(root, 'bad', 'broken.controller.js')
        await writeFile(file, 'export default 123\n', 'utf8')

        const http = new Http({ port: 5017 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: bad/broken.controller.js (number) - default export must be ControllerRegisterProps or ControllerRegisterProps[]'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  })
})
