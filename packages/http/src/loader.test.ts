import { describe, it, expect, afterEach, vi } from 'vitest'
import { Http } from './http'
import { Loader } from './loader'
import { defineController } from './controller'
import { compileRoutePath, toRouterPath } from '@hile/loader'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('Loader', () => {
  let closeServer: (() => Promise<void>) | undefined

  afterEach(async () => {
    await closeServer?.()
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
    it('matches a required catch-all and exposes only its declared slash-joined parameter', async () => {
      const http = new Http({ port: 5041 })
      const loader = new Loader(http)
      loader.compile('/[tenant]/files/[...paths]', defineController('GET', (ctx) => ({
        tenant: ctx.params.tenant,
        paths: ctx.params.paths,
        hasRaw: Object.hasOwn(ctx.params, '*'),
        nullPrototype: Object.getPrototypeOf(ctx.params) === null,
      })))
      loader.compile('/:tenant/archive/[...entries]', defineController('GET', (ctx) => ({
        tenant: ctx.params.tenant,
        entries: ctx.params.entries,
        hasRaw: Object.hasOwn(ctx.params, '*'),
      })))

      closeServer = await http.listen()
      const matched = await fetch('http://127.0.0.1:5041/acme/files/a/b/c')
      expect(await matched.json()).toEqual({
        tenant: 'acme',
        paths: 'a/b/c',
        hasRaw: false,
        nullPrototype: true,
      })
      expect((await fetch('http://127.0.0.1:5041/acme/files/')).status).toBe(404)
      expect(await (await fetch('http://127.0.0.1:5041/acme/archive/2026/entry')).json()).toEqual({
        tenant: 'acme',
        entries: '2026/entry',
        hasRaw: false,
      })
      expect((await fetch('http://127.0.0.1:5041/acme/archive/')).status).toBe(404)
    })

    it('keeps static, parameter, and catch-all precedence independent of registration order', async () => {
      const http = new Http({ port: 5042 })
      const loader = new Loader(http)
      loader.compile('/assets/[...paths]', defineController('GET', () => 'catch-all'))
      loader.compile('/assets/[name]', defineController('GET', () => 'parameter'))
      loader.compile('/assets/readme', defineController('GET', () => 'static'))
      loader.compile('/assets/...', defineController('GET', () => 'literal-dots'))
      loader.compile('/reverse-assets/readme', defineController('GET', () => 'reverse-static'))
      loader.compile('/reverse-assets/[name]', defineController('GET', () => 'reverse-parameter'))
      loader.compile('/reverse-assets/[...paths]', defineController('GET', () => 'reverse-catch-all'))

      closeServer = await http.listen()
      expect(await (await fetch('http://127.0.0.1:5042/assets/readme')).text()).toBe('static')
      expect(await (await fetch('http://127.0.0.1:5042/assets/license')).text()).toBe('parameter')
      expect(await (await fetch('http://127.0.0.1:5042/assets/icons/logo.svg')).text()).toBe('catch-all')
      expect(await (await fetch('http://127.0.0.1:5042/assets/...')).text()).toBe('literal-dots')
      expect(await (await fetch('http://127.0.0.1:5042/reverse-assets/readme')).text()).toBe('reverse-static')
      expect(await (await fetch('http://127.0.0.1:5042/reverse-assets/license')).text()).toBe('reverse-parameter')
      expect(await (await fetch('http://127.0.0.1:5042/reverse-assets/icons/logo.svg')).text()).toBe('reverse-catch-all')
    })

    it('rejects equivalent parameter and catch-all shapes with different names', () => {
      const http = new Http({ port: 5043 })
      const loader = new Loader(http)
      loader.compile('/users/[id]', defineController('GET', () => 'id'))
      expect(() => loader.compile('/users/[name]', defineController('GET', () => 'name')))
        .toThrow('route conflict')

      loader.compile('/files/[...paths]', defineController('POST', () => 'paths'))
      expect(() => loader.compile('/files/[...rest]', defineController('POST', () => 'rest')))
        .toThrow('route conflict')
    })

    it('keeps configured prefixes distinct from encoded file-route shapes', () => {
      const http = { route: vi.fn(() => vi.fn()) } as unknown as Http
      const loader = new Loader(http)

      loader.compile('/[id]', defineController('GET', () => undefined), { prefix: '/s:users' })

      expect(() => loader.compile('/users/[id]', defineController('GET', () => undefined))).not.toThrow()
    })

    it('normalizes equivalent dynamic prefix shapes for conflict detection', () => {
      const http = { route: vi.fn(() => vi.fn()) } as unknown as Http
      const loader = new Loader(http)
      loader.compile('/users/[id]', defineController('GET', () => undefined), { prefix: '/:tenant' })

      expect(() => loader.compile('/users/[name]', defineController('GET', () => undefined), {
        prefix: '/:workspace',
      })).toThrow('route conflict')
    })

    it('normalizes configured and inline prefixes to the same conflict shape', () => {
      const http = { route: vi.fn(() => vi.fn()) } as unknown as Http
      const loader = new Loader(http)
      loader.compile('/users/[id]', defineController('GET', () => undefined), { prefix: '/:tenant' })

      expect(() => loader.compile('/:workspace/users/[name]', defineController('GET', () => undefined)))
        .toThrow('route conflict')
    })

    it('normalizes equivalent mixed native and portable shapes for conflict detection', () => {
      const http = { route: vi.fn(() => vi.fn()) } as unknown as Http
      const loader = new Loader(http)
      loader.compile('/:tenant/users/[id]', defineController('GET', () => undefined))

      expect(() => loader.compile('/:workspace/users/[name]', defineController('GET', () => undefined)))
        .toThrow('route conflict')
    })

    it('applies conflict policy across pure and mixed spellings of the same route', () => {
      const route = vi.fn(() => vi.fn())
      const onConflict = vi.fn()
      const loader = new Loader({ route } as unknown as Http)
      loader.compile('/[tenant]/users/[id]', defineController('GET', () => undefined))

      loader.compile('/:tenant/users/[id]', defineController('GET', () => undefined), {
        conflict: 'warn',
        onConflict,
      })

      expect(route).toHaveBeenCalledTimes(1)
      expect(onConflict).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'keep' }))
    })

    it('keeps escaped literal colons distinct in native routes', () => {
      const route = vi.fn(() => vi.fn())
      const loader = new Loader({ route } as unknown as Http)

      loader.compile('/literal::foo', defineController('GET', () => undefined))
      expect(() => loader.compile('/literal::bar', defineController('GET', () => undefined)))
        .not.toThrow()
      expect(route).toHaveBeenCalledTimes(2)
    })

    it('normalizes find-my-way parameter names that start with digits', () => {
      const route = vi.fn(() => vi.fn())
      const loader = new Loader({ route } as unknown as Http)

      loader.compile('/:123', defineController('GET', () => undefined))
      expect(() => loader.compile('/:456', defineController('GET', () => undefined)))
        .toThrow('route conflict')
      expect(route).toHaveBeenCalledTimes(1)
    })

    it('keeps direct compile calls with find-my-way regex syntax backward compatible', async () => {
      const http = new Http({ port: 5046 })
      const loader = new Loader(http)
      loader.compile('/items/:id(\\d+)', defineController('GET', (ctx) => ctx.params.id))
      loader.compile('/codes/:id([0-9]+)', defineController('GET', (ctx) => ctx.params.id))

      closeServer = await http.listen()
      expect(await (await fetch('http://127.0.0.1:5046/items/42')).text()).toBe('42')
      expect((await fetch('http://127.0.0.1:5046/items/text')).status).toBe(404)
      expect(await (await fetch('http://127.0.0.1:5046/codes/42')).text()).toBe('42')
      expect((await fetch('http://127.0.0.1:5046/codes/text')).status).toBe(404)
    })

    it('keeps mixed parameter suffixes backward compatible in direct compile calls', () => {
      const route = vi.fn(() => vi.fn())
      const loader = new Loader({ route } as unknown as Http)

      loader.compile('/files/[id].json', defineController('GET', () => undefined))

      expect(route).toHaveBeenCalledWith('GET', '/files/:id.json', expect.any(Function))
    })

    it('normalizes route groups before classifying file-route syntax', () => {
      const route = vi.fn(() => vi.fn())
      const loader = new Loader({ route } as unknown as Http)

      loader.compile('/(admin)/users/[id]', defineController('GET', () => undefined))
      loader.compile('/(root)/index', defineController('POST', () => undefined))

      expect(route).toHaveBeenCalledWith('GET', '/users/:id', expect.any(Function))
      expect(route).toHaveBeenCalledWith('POST', '/', expect.any(Function))
    })

    it('keeps a native dynamic prefix while compiling portable path segments', () => {
      const route = vi.fn(() => vi.fn())
      const loader = new Loader({ route } as unknown as Http)

      loader.compile('/users/[id]', defineController('GET', () => undefined), { prefix: '/:version' })
      loader.compile('/:tenant/users/[id]', defineController('POST', () => undefined))
      loader.compile('/users/[id]', defineController('PATCH', () => undefined), { prefix: '/[workspace]' })

      expect(route).toHaveBeenCalledWith('GET', '/:version/users/:id', expect.any(Function))
      expect(route).toHaveBeenCalledWith('POST', '/:tenant/users/:id', expect.any(Function))
      expect(route).toHaveBeenCalledWith('PATCH', '/:workspace/users/:id', expect.any(Function))
      expect(() => loader.compile('/files/[...paths]', defineController('DELETE', () => undefined), {
        prefix: '/:paths',
      })).toThrow(/duplicated/)
    })
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

      const releaseOld = loader.compile('/override/[...paths]', defineController('GET', () => 'old'))
      const releaseNew = loader.compile('/override/[...rest]', defineController('GET', (ctx) => ctx.params.rest), {
        conflict: 'override',
      })
      releaseOld()

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5015/override/a/b')
      expect(await res.text()).toBe('a/b')
      releaseNew()
      expect((await fetch('http://127.0.0.1:5015/override/a/b')).status).toBe(404)
    })

    it('allows an unload cleanup to be retried after it throws', () => {
      const off = vi.fn()
        .mockImplementationOnce(() => { throw new Error('off failed') })
        .mockImplementationOnce(() => undefined)
      const http = { route: vi.fn(() => off) } as unknown as Http
      const loader = new Loader(http)
      const unload = loader.compile('/retry-unload', defineController('GET', () => undefined))

      expect(() => unload()).toThrow('off failed')
      expect(() => unload()).not.toThrow()
      expect(off).toHaveBeenCalledTimes(2)
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
    it('keeps a batch invisible until every controller module has imported', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      let releaseImport: (() => void) | undefined
      let loading: Promise<() => void> | undefined
      try {
        const gatedController = (id: number, value: string) => `
          globalThis.__hileHttpLoaderImportCount++
          await globalThis.__hileHttpLoaderImportGate
          export default { id: ${id}, method: 'GET', middlewares: [(ctx) => { ctx.body = '${value}' }], data: {} }
        `
        await writeFile(root + '/a.controller.js', gatedController(1, 'a'), 'utf8')
        await writeFile(root + '/z.controller.js', gatedController(2, 'z'), 'utf8')
        ;(globalThis as any).__hileHttpLoaderImportCount = 0
        ;(globalThis as any).__hileHttpLoaderImportGate = new Promise<void>((resolve) => {
          releaseImport = resolve
        })

        const http = new Http({ port: 5047 })
        const loader = new Loader(http)
        closeServer = await http.listen()
        loading = loader.from(root)

        await vi.waitFor(() => expect((globalThis as any).__hileHttpLoaderImportCount).toBe(2))
        expect((await fetch('http://127.0.0.1:5047/a')).status).toBe(404)
        expect((await fetch('http://127.0.0.1:5047/z')).status).toBe(404)

        releaseImport()
        const unload = await loading
        expect(await (await fetch('http://127.0.0.1:5047/a')).text()).toBe('a')
        expect(await (await fetch('http://127.0.0.1:5047/z')).text()).toBe('z')
        unload()
      } finally {
        releaseImport?.()
        await loading?.then(unload => unload()).catch(() => {})
        delete (globalThis as any).__hileHttpLoaderImportCount
        delete (globalThis as any).__hileHttpLoaderImportGate
        await rm(root, { recursive: true, force: true })
      }
    })

    it('rolls back equivalent file routes and permits a clean retry', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'users'), { recursive: true })
        const controller = (value: string) =>
          `export default { id: 1, method: 'GET', middlewares: [(ctx) => { ctx.body = '${value}' }], data: {} }`
        await writeFile(join(root, 'users', '[id].controller.js'), controller('id'), 'utf8')
        await writeFile(join(root, 'users', '[name].controller.js'), controller('name'), 'utf8')

        const http = new Http({ port: 5044 })
        const loader = new Loader(http)
        const conflict = await loader.from(root).catch(error => error as Error)
        expect(conflict.message).toContain('route conflict')
        expect(conflict.message).toContain('users/[id].controller.js')
        expect(conflict.message).toContain('users/[name].controller.js')
        await rm(join(root, 'users', '[name].controller.js'))
        const unload = await loader.from(root)
        closeServer = await http.listen()
        expect(await (await fetch('http://127.0.0.1:5044/users/42')).text()).toBe('id')
        unload()
        expect((await fetch('http://127.0.0.1:5044/users/42')).status).toBe(404)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('does not treat declaration files or source maps as controllers', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await writeFile(root + '/valid.controller.js',
          `export default { id: 1, method: 'GET', middlewares: [(ctx) => { ctx.body = 'valid' }], data: {} }`, 'utf8')
        await writeFile(root + '/types.controller.d.ts', 'not valid JavaScript', 'utf8')
        await writeFile(root + '/valid.controller.js.map', 'not valid JavaScript', 'utf8')
        const http = new Http({ port: 5045 })
        const loader = new Loader(http)
        const unload = await loader.from(root)
        closeServer = await http.listen()
        expect(await (await fetch('http://127.0.0.1:5045/valid')).text()).toBe('valid')
        unload()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

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

    it('空数组导出触发 summarizeExportType array(empty)', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'emptyarr'), { recursive: true })
        const file = join(root, 'emptyarr', 'e.controller.js')
        await writeFile(file, 'export default []\n', 'utf8')

        const http = new Http({ port: 5018 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: emptyarr/e.controller.js (array(empty))'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('非空数组导出触发 summarizeExportType array(len=N, first=...)', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'nonempty'), { recursive: true })
        const file = join(root, 'nonempty', 'n.controller.js')
        await writeFile(file, 'export default [42]\n', 'utf8')

        const http = new Http({ port: 5019 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: nonempty/n.controller.js (array(len=1, first=number))'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('对象导出触发 summarizeExportType object(keys=[...])', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'obj'), { recursive: true })
        const file = join(root, 'obj', 'o.controller.js')
        await writeFile(file, 'export default { myKey: "val" }\n', 'utf8')

        const http = new Http({ port: 5021 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: obj/o.controller.js (object(keys=[myKey]))'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('undefined 默认导出触发 summarizeExportType undefined', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'undef'), { recursive: true })
        const file = join(root, 'undef', 'u.controller.js')
        await writeFile(file, 'export const notDefault = 1\n', 'utf8')

        const http = new Http({ port: 5022 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: undef/u.controller.js (undefined)'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('null 默认导出触发 summarizeExportType null', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'nil'), { recursive: true })
        const file = join(root, 'nil', 'l.controller.js')
        await writeFile(file, 'export default null\n', 'utf8')

        const http = new Http({ port: 5023 })
        const loader = new Loader(http)

        await expect(loader.from(root)).rejects.toThrow(
          'invalid service file: nil/l.controller.js (null)'
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('空数组导出抛出错误', async () => {
      const http = new Http({ port: 5025 })
      const loader = new Loader(http)
      expect(() => {
        (loader as any).compile('/empty', [])
      }).toThrow('controller array is empty')
    })

    it('非法数组元素导出抛出错误', async () => {
      const http = new Http({ port: 5026 })
      const loader = new Loader(http)
      expect(() => {
        (loader as any).compile('/bad-arr', [42])
      }).toThrow('default export must be ControllerRegisterProps')
    })

    it('非法单对象导出抛出错误', async () => {
      const http = new Http({ port: 5027 })
      const loader = new Loader(http)
      expect(() => {
        (loader as any).compile('/bad-obj', { not: 'valid' })
      }).toThrow('default export must be ControllerRegisterProps')
    })
  })

  describe('路径规范化（normalizePath）', () => {
    it('替换反斜杠为正斜杠', () => {
      const http = new Http({ port: 5030 })
      const loader = new Loader(http)
      const result = (loader as any).compile('/win\\path', defineController('GET', () => 'ok'))
      expect(result).toBeDefined()
    })

    it('删除括号内的内容', async () => {
      const root = await mkdtemp(join(tmpdir(), 'hile-http-loader-'))
      try {
        await mkdir(join(root, 'user', '(group)'), { recursive: true })
        await writeFile(
          join(root, 'user', '(group)', 'list.controller.js'),
          `export default [{ id: 1, method: 'GET', middlewares: [(ctx) => { ctx.body = 'clean' }], data: {} }]`,
          'utf8',
        )

        const http = new Http({ port: 5031 })
        const loader = new Loader(http)
        const off = await loader.from(root)

        closeServer = await http.listen()
        const res = await fetch('http://127.0.0.1:5031/user/list')
        expect(await res.text()).toBe('clean')

        off()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })

    it('合并连续斜杠', async () => {
      const http = new Http({ port: 5032 })
      const loader = new Loader(http)
      const controller = defineController('GET', () => 'slash')
      loader.compile('/api//test', controller)

      closeServer = await http.listen()
      const res = await fetch('http://127.0.0.1:5032/api/test')
      expect(await res.text()).toBe('slash')
    })
  })

  describe('compile - 卸载清理', () => {
    it('cleanup 回调注销所有路由', async () => {
      const http = new Http({ port: 5040 })
      const loader = new Loader(http)
      const c1 = defineController('GET', () => 'a')
      const c2 = defineController('POST', () => 'b')
      const off = loader.compile('/multi-clean', [c1, c2])

      closeServer = await http.listen()

      const getRes = await fetch('http://127.0.0.1:5040/multi-clean')
      expect(await getRes.text()).toBe('a')

      off()

      const getRes2 = await fetch('http://127.0.0.1:5040/multi-clean')
      expect(getRes2.status).toBe(404)

      const postRes = await fetch('http://127.0.0.1:5040/multi-clean', { method: 'POST' })
      expect(postRes.status).toBe(404)
    })
  })
})
