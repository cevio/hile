import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageLoader, defineMessage, NotFoundException } from './index'
import { toRouterPath } from './utils'

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
  })
})
