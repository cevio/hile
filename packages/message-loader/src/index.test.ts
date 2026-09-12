import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageLoader, defineMessage, NotFoundException } from './index'
import { toRouterPath, type ScannedFile } from '@hile/loader'
import type { MessageRegisterProps } from './message'
import * as routeOwners from './route-owner'

describe('toRouterPath', () => {
  it('将 [param] 转为 :param', () => {
    expect(toRouterPath('/users/[id]')).toBe('/users/:id')
  })

  it('支持多个参数', () => {
    expect(toRouterPath('/[category]/[id]')).toBe('/:category/:id')
  })

  it('无参数路径原样返回', () => {
    expect(toRouterPath('/hello/world')).toBe('/hello/world')
  })
})

describe('defineMessage', () => {
  it('返回包含 id 和 fn 的注册信息', () => {
    const fn = () => 'hello'
    const result = defineMessage(fn)
    expect(result).toHaveProperty('id')
    expect(result).toHaveProperty('fn')
    expect(result.fn).toBe(fn)
  })

  it('每次调用分配递增的 id', () => {
    const r1 = defineMessage(() => 'a')
    const r2 = defineMessage(() => 'b')
    expect(r2.id).toBeGreaterThan(r1.id)
  })

  it('snapshots the optional protocol and keeps ordinary definitions unmarked', () => {
    const options = { protocol: 'http' }
    const definition = defineMessage(() => 'http', options)
    options.protocol = 'changed'

    expect(definition.protocol).toBe('http')
    expect(defineMessage(() => 'ordinary').protocol).toBeUndefined()
  })

  it.each(['', 'a'.repeat(129), 'invalid protocol'])('rejects invalid definition protocol %s', (protocol) => {
    expect(() => defineMessage(() => undefined, { protocol })).toThrow('Invalid message protocol')
  })
})

describe('MessageLoader', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'hile-message-loader-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function writeMessageFile(relativePath: string, content: string) {
    const fullPath = join(root, relativePath)
    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await writeFile(fullPath, content, 'utf8')
  }

  describe('constructor - 默认配置', () => {
    it('suffix 默认为 msg', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('hello.msg.js', `
        export default { id: 1, fn: () => 'hello' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/hello', {})
      expect(result).toBe('hello')
      off()
    })

    it('defaultSuffix 默认为 /index', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('index.msg.js', `
        export default { id: 1, fn: () => 'root' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/', {})
      expect(result).toBe('root')
      off()
    })

    it('prefix 默认为空', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('hello.msg.js', `
        export default { id: 1, fn: () => 'no-prefix' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/hello', {})
      expect(result).toBe('no-prefix')
      off()
    })
  })

  describe('load - 从目录加载消息处理器', () => {
    it('加载 .msg.js 文件并注册路由', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('greet.msg.js', `
        export default { id: 1, fn: (ctx) => 'hello ' + ctx.data.name }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/greet', { name: 'world' })
      expect(result).toBe('hello world')
      off()
    })

    it('加载嵌套目录中的消息', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('users/list.msg.js', `
        export default { id: 1, fn: () => 'user-list' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/users/list', {})
      expect(result).toBe('user-list')
      off()
    })

    it('index 文件映射为父级路径', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('users/index.msg.js', `
        export default { id: 1, fn: () => 'users-index' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/users', {})
      expect(result).toBe('users-index')
      off()
    })

    it('跳过没有 default 导出的文件', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('empty.msg.js', `
        export const notDefault = 123
      `)
      await writeMessageFile('valid.msg.js', `
        export default { id: 1, fn: () => 'valid' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/valid', {})
      expect(result).toBe('valid')
      off()
    })

    it('返回注销函数，调用后路由不再匹配', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('temp.msg.js', `
        export default { id: 1, fn: () => 'temp' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/temp', {})
      expect(result).toBe('temp')

      off()

      await expect(loader.dispatch('/temp', {})).rejects.toThrow(NotFoundException)
    })

    it('空目录不会报错', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      const off = await loader.load(root)
      off()
    })
  })

  describe('dispatch - 消息分发', () => {
    it('路径不存在时抛出错误', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await expect(loader.dispatch('/nonexistent', {})).rejects.toThrow(NotFoundException)
    })

    it('传递 data 参数到处理器', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('echo.msg.js', `
        export default { id: 1, fn: (ctx) => ctx.data }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/echo', { foo: 'bar' })
      expect(result).toEqual({ foo: 'bar' })
      off()
    })

    it('传递 url 参数到处理器', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('url-check.msg.js', `
        export default { id: 1, fn: (ctx) => ctx.url }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/url-check', {})
      expect(result).toBe('/url-check')
      off()
    })

    it('支持异步处理器', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('async.msg.js', `
        export default { id: 1, fn: async (ctx) => {
          return 'async-' + ctx.data.value
        }}
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/async', { value: 'ok' })
      expect(result).toBe('async-ok')
      off()
    })
  })

  describe('动态路由参数', () => {
    it('[param] 格式路径参数被正确解析', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('users/[id].msg.js', `
        export default { id: 1, fn: (ctx) => 'user-' + ctx.params.id }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/users/42', {})
      expect(result).toBe('user-42')
      off()
    })

    it('支持多个路径参数', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      await writeMessageFile('[category]/[id].msg.js', `
        export default { id: 1, fn: (ctx) => ctx.params.category + '-' + ctx.params.id }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/books/99', {})
      expect(result).toBe('books-99')
      off()
    })
  })

  describe('prefix - 路径前缀', () => {
    it('带前缀的路由正确匹配', async () => {
      const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' })
      await writeMessageFile('hello.msg.js', `
        export default { id: 1, fn: () => 'prefixed' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/-/hello', {})
      expect(result).toBe('prefixed')
      off()
    })

    it('带前缀的 index 路由映射正确', async () => {
      const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' })
      await writeMessageFile('index.msg.js', `
        export default { id: 1, fn: () => 'prefix-root' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/-/', {})
      expect(result).toBe('prefix-root')
      off()
    })

    it('带前缀的动态路由参数正确传递', async () => {
      const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' })
      await writeMessageFile('items/[id].msg.js', `
        export default { id: 1, fn: (ctx) => 'item-' + ctx.params.id }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/-/items/7', {})
      expect(result).toBe('item-7')
      off()
    })
  })

  describe('自定义 suffix', () => {
    it('使用自定义 suffix 匹配文件', async () => {
      const loader = new MessageLoader({ suffix: 'handler' })
      await writeMessageFile('ping.handler.js', `
        export default { id: 1, fn: () => 'pong' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/ping', {})
      expect(result).toBe('pong')
      off()
    })
  })

  describe('自定义 defaultSuffix', () => {
    it('自定义 defaultSuffix 被正确去除', async () => {
      const loader = new MessageLoader({ suffix: 'msg', defaultSuffix: '/home' })
      await writeMessageFile('users/home.msg.js', `
        export default { id: 1, fn: () => 'users-home' }
      `)
      const off = await loader.load(root)
      const result = await loader.dispatch('/users', {})
      expect(result).toBe('users-home')
      off()
    })
  })

  describe('register - 动态注册消息处理器', () => {
    it('register 注册处理器后可以 dispatch', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      const handler = ({ data }: any) => `hello ${data.name}`
      const unregister = loader.register('/hello', handler)

      const result = await loader.dispatch('/hello', { name: 'world' })
      expect(result).toBe('hello world')
      unregister()
    })

    it('register 支持动态参数路由', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      const handler = ({ params }: any) => `user-${params.id}`
      const unregister = loader.register('/users/:id', handler)

      const result = await loader.dispatch('/users/42', {})
      expect(result).toBe('user-42')
      unregister()
    })

    it('unregister 后路由不再匹配', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      const handler = () => 'temp'
      const unregister = loader.register('/temp', handler)

      const before = await loader.dispatch('/temp', {})
      expect(before).toBe('temp')

      unregister()

      await expect(loader.dispatch('/temp', {})).rejects.toThrow(NotFoundException)
    })

    it('register 注册后通过 dispatch 匹配（不处理 prefix）', async () => {
      const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' })
      const handler = () => 'prefixed-register'
      const unregister = loader.register('/ping', handler)

      const result = await loader.dispatch('/ping', {})
      expect(result).toBe('prefixed-register')
      unregister()
    })

    it('多个 register 同时存在互不干扰', async () => {
      const loader = new MessageLoader({ suffix: 'msg' })
      const un1 = loader.register('/a', () => 'A')
      const un2 = loader.register('/b', () => 'B')

      expect(await loader.dispatch('/a', {})).toBe('A')
      expect(await loader.dispatch('/b', {})).toBe('B')

      un1()
      await expect(loader.dispatch('/a', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/b', {})).toBe('B')

      un2()
    })

    it('rejects duplicate normalized paths without replacing their owner', async () => {
      const loader = new MessageLoader({})
      const original = vi.fn(() => 'original')
      const release = loader.register('/users/list', original)

      expect(() => loader.register('users//./list/', () => 'replacement'))
        .toThrow('Message routes conflict')
      expect(await loader.dispatch('/users/list', {})).toBe('original')
      expect(original).toHaveBeenCalledTimes(1)
      release()
    })

    it('an old release cannot unregister a new owner of the same path', async () => {
      const loader = new MessageLoader({})
      const releaseOld = loader.register('/replace', () => 'old')
      releaseOld()
      const releaseNew = loader.register('/replace', () => 'new')

      releaseOld()
      expect(await loader.dispatch('/replace', {})).toBe('new')
      releaseNew()
    })

    it.each([
      ['/users/:id', '/users/:name'],
      ['/a/:value', '/:value/b'],
      ['/files/:path+', '/files/**:rest'],
      ['/items/:id(\\d+)', '/items/:slug([a-z]+)'],
      ['/items/:id?', '/items'],
    ])('rejects equal-priority ambiguous patterns %s and %s', (first, second) => {
      const loader = new MessageLoader({})
      loader.register(first, () => 'first')
      expect(() => loader.register(second, () => 'second'))
        .toThrow('Message routes conflict')
    })

    it('preserves static, parameter, and catch-all precedence and independent release', async () => {
      const loader = new MessageLoader({})
      const releaseFallback = loader.register('/files/**:rest', () => 'fallback')
      const releaseParameter = loader.register('/files/:name', () => 'parameter')
      const releaseStatic = loader.register('/files/readme', () => 'static')
      loader.register('/other/:name', () => 'other')

      expect(await loader.dispatch('/files/readme', {})).toBe('static')
      expect(await loader.dispatch('/files/document', {})).toBe('parameter')
      expect(await loader.dispatch('/files/a/b', {})).toBe('fallback')
      releaseStatic()
      expect(await loader.dispatch('/files/readme', {})).toBe('parameter')
      releaseParameter()
      expect(await loader.dispatch('/files/readme', {})).toBe('fallback')
      releaseFallback()
      expect(await loader.dispatch('/other/name', {})).toBe('other')
    })

    it('removes an owned route without rebuilding every remaining route', async () => {
      const loader = new MessageLoader({})
      const releases = Array.from({ length: 100 }, (_, index) =>
        loader.register(`/bulk/${index}`, () => index))
      const rebuild = vi.spyOn(routeOwners, 'buildRouter')

      releases[50]()

      expect(rebuild).not.toHaveBeenCalled()
      await expect(loader.dispatch('/bulk/50', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/bulk/49', {})).toBe(49)
      expect(await loader.dispatch('/bulk/51', {})).toBe(51)
      rebuild.mockRestore()
    })

    it('keeps a single regex parameter intact and distinct static branches available', async () => {
      const loader = new MessageLoader({})
      loader.register('/items/:id(\\d+)', ({ params }) => params?.id)
      loader.register('/users/:id', () => 'user')

      expect(await loader.dispatch('/items/42', {})).toBe('42')
      await expect(loader.dispatch('/items/text', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/users/42', {})).toBe('user')
    })

    it('normalizes dispatch matching but preserves the original invocation URL', async () => {
      const loader = new MessageLoader({})
      loader.register('users//./list/', ({ url }) => url)

      expect(await loader.dispatch('/users/extra/../list/', {})).toBe('/users/extra/../list/')
    })

    it('checks protocol before executing any matching handler', async () => {
      const loader = new MessageLoader({})
      const ordinary = vi.fn(() => 'ordinary')
      const http = vi.fn(() => 'http')
      loader.register('/ordinary', ordinary)
      loader.register('/http', http, { protocol: '@hile/http-over-micro' })

      await expect(loader.dispatch('/ordinary', {}, {}, { protocol: '@hile/http-over-micro' }))
        .rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' })
      await expect(loader.dispatch('/http', {}))
        .rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' })
      expect(ordinary).not.toHaveBeenCalled()
      expect(http).not.toHaveBeenCalled()
      expect(await loader.dispatch('/ordinary', {})).toBe('ordinary')
      expect(await loader.dispatch('/http', {}, {}, { protocol: '@hile/http-over-micro' }))
        .toBe('http')
    })

    it('does not fall through to another route when the selected protocol differs', async () => {
      const loader = new MessageLoader({})
      const fallback = vi.fn(() => 'fallback')
      loader.register('/items/fixed', () => 'private')
      loader.register('/items/:id', fallback, { protocol: 'http' })

      await expect(loader.dispatch('/items/fixed', {}, {}, { protocol: 'http' }))
        .rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' })
      expect(fallback).not.toHaveBeenCalled()
    })

    it('snapshots protocol registration and ignores protocol-looking payload or extras', async () => {
      const loader = new MessageLoader({})
      const options = { protocol: 'http' }
      loader.register('/http', () => 'http', options)
      options.protocol = 'changed'

      await expect(loader.dispatch('/http', { protocol: 'http' }, { protocol: 'http' }))
        .rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' })
      expect(await loader.dispatch('/http', {}, {}, { protocol: 'http' })).toBe('http')
    })

    it.each(['', 'a'.repeat(129), 'invalid protocol'])('rejects invalid protocol %s', (protocol) => {
      const loader = new MessageLoader({})
      expect(() => loader.register('/invalid', () => undefined, { protocol }))
        .toThrow('Invalid message protocol')
    })
  })

  describe('atomic route loading', () => {
    it('unloads base-loader registrations if the final router build fails', async () => {
      class CleanupLoader extends MessageLoader {
        released = 0

        protected bind(file: ScannedFile, definition: MessageRegisterProps) {
          const release = super.bind(file, definition)
          return () => {
            this.released++
            release()
          }
        }
      }
      const loader = new CleanupLoader({})
      await writeMessageFile('only.msg.js', `export default { id: 1, fn: () => 'only' }`)
      const build = vi.spyOn(routeOwners, 'buildRouter').mockImplementationOnce(() => {
        throw new Error('commit rejected')
      })
      try {
        await expect(loader.load(root)).rejects.toThrow('commit rejected')
        expect(loader.released).toBe(1)
        await expect(loader.dispatch('/only', {})).rejects.toThrow(NotFoundException)
        const unload = await loader.load(root)
        expect(await loader.dispatch('/only', {})).toBe('only')
        unload()
        expect(loader.released).toBe(2)
      } finally {
        build.mockRestore()
      }
    })

    it('rejects raw registration against a file owner', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('users/[id].msg.js', `export default { id: 1, fn: () => 'file' }`)
      const release = await loader.load(root)

      expect(() => loader.register('/users/:name', () => 'raw'))
        .toThrow('Message routes conflict')
      expect(await loader.dispatch('/users/42', {})).toBe('file')
      release()
      loader.register('/users/:name', () => 'raw')
      expect(await loader.dispatch('/users/42', {})).toBe('raw')
    })

    it('rejects file routes that normalize to the same URL and allows retry after rollback', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('items.msg.js', `export default { id: 1, fn: () => 'first' }`)
      await writeMessageFile('items/index.msg.js', `export default { id: 2, fn: () => 'second' }`)

      await expect(loader.load(root)).rejects.toThrow('Message routes conflict')
      await expect(loader.dispatch('/items', {})).rejects.toThrow(NotFoundException)
      await rm(join(root, 'items/index.msg.js'))
      const release = await loader.load(root)
      expect(await loader.dispatch('/items', {})).toBe('first')
      release()
    })

    it('discards the batch even when an overriding bind throws after super.bind', async () => {
      class RejectingLoader extends MessageLoader {
        protected bind(file: ScannedFile, definition: MessageRegisterProps) {
          super.bind(file, definition)
          throw new Error('binding rejected')
        }
      }
      const loader = new RejectingLoader({})
      loader.register('/existing', () => 'existing')
      await writeMessageFile('new.msg.js', `export default { id: 1, fn: () => 'new' }`)

      await expect(loader.load(root)).rejects.toThrow('binding rejected')
      await expect(loader.dispatch('/new', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/existing', {})).toBe('existing')
      loader.register('/new', () => 'replacement')
      expect(await loader.dispatch('/new', {})).toBe('replacement')
    })

    it('rolls back an import failure and releases the load lock', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('valid.msg.js', `export default { id: 1, fn: () => 'valid' }`)
      await writeMessageFile('invalid.msg.js', `throw new Error('import rejected')`)

      await expect(loader.load(root)).rejects.toThrow('import rejected')
      await expect(loader.dispatch('/valid', {})).rejects.toThrow(NotFoundException)
      loader.register('/valid', () => 'replacement')
      expect(await loader.dispatch('/valid', {})).toBe('replacement')
    })

    it('uses the same ownership checks for files and raw registrations', async () => {
      const loader = new MessageLoader({})
      loader.register('/users/:id', () => 'existing')
      await writeMessageFile('users/[name].msg.js', `export default { id: 1, fn: () => 'file' }`)
      await writeMessageFile('unrelated.msg.js', `export default { id: 2, fn: () => 'new' }`)

      await expect(loader.load(root)).rejects.toThrow('Message routes conflict')
      expect(await loader.dispatch('/users/42', {})).toBe('existing')
      await expect(loader.dispatch('/unrelated', {})).rejects.toThrow(NotFoundException)
    })

    it('does not expose routes while their loading batch is still being bound', async () => {
      class ObservingLoader extends MessageLoader {
        readonly observations: Promise<unknown>[] = []

        protected bind(file: ScannedFile, definition: MessageRegisterProps) {
          const release = super.bind(file, definition)
          this.observations.push(this.dispatch(file.routePath, {}).catch(error => error.status))
          return release
        }
      }
      const loader = new ObservingLoader({})
      await writeMessageFile('first.msg.js', `export default { id: 1, fn: () => 'first' }`)
      await writeMessageFile('second.msg.js', `export default { id: 2, fn: () => 'second' }`)

      const release = await loader.load(root)
      expect(await Promise.all(loader.observations)).toEqual(['NOT_FOUND', 'NOT_FOUND'])
      expect(await loader.dispatch('/first', {})).toBe('first')
      release()
    })

    it('rejects a concurrent load and raw writes without interfering with the first batch', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('only.msg.js', `export default { id: 1, fn: () => 'only' }`)
      const first = loader.load(root)

      await expect(loader.load(root)).rejects.toMatchObject({ status: 'HILE_MESSAGE_LOAD_IN_PROGRESS' })
      expect(() => loader.register('/racing', () => 'racing'))
        .toThrow('Message load is in progress')
      const release = await first
      expect(await loader.dispatch('/only', {})).toBe('only')
      release()
    })

    it('does not restore an old route released during another directory load', async () => {
      const loader = new MessageLoader({})
      const releaseOld = loader.register('/old', () => 'old')
      await writeMessageFile('new.msg.js', `export default { id: 1, fn: () => 'new' }`)
      const loading = loader.load(root)
      releaseOld()

      const releaseNew = await loading
      await expect(loader.dispatch('/old', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/new', {})).toBe('new')
      releaseNew()
    })

    it('keeps a file protocol declaration and releases only that batch', async () => {
      const loader = new MessageLoader({})
      loader.register('/existing', () => 'existing')
      await writeMessageFile('http.msg.js', `export default { id: 1, protocol: 'http', fn: () => 'http' }`)
      const release = await loader.load(root)

      await expect(loader.dispatch('/http', {}))
        .rejects.toMatchObject({ status: 'HILE_MESSAGE_PROTOCOL_MISMATCH' })
      expect(await loader.dispatch('/http', {}, {}, { protocol: 'http' })).toBe('http')
      release()
      release()
      expect(await loader.dispatch('/existing', {})).toBe('existing')
      await expect(loader.dispatch('/http', {}, {}, { protocol: 'http' }))
        .rejects.toThrow(NotFoundException)
    })

    it('keeps sequential batches independent and makes old unload callbacks harmless', async () => {
      const loader = new MessageLoader({})
      await writeMessageFile('first/one.msg.js', `export default { id: 1, fn: () => 'one' }`)
      await writeMessageFile('second/two.msg.js', `export default { id: 2, fn: () => 'two' }`)
      const releaseFirst = await loader.load(join(root, 'first'))
      const releaseSecond = await loader.load(join(root, 'second'))

      releaseFirst()
      loader.register('/one', () => 'replacement')
      releaseFirst()
      expect(await loader.dispatch('/one', {})).toBe('replacement')
      expect(await loader.dispatch('/two', {})).toBe('two')
      releaseSecond()
      await expect(loader.dispatch('/two', {})).rejects.toThrow(NotFoundException)
      expect(await loader.dispatch('/one', {})).toBe('replacement')
    })
  })
})
