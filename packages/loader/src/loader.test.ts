import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/* ============ compileRoutePath ============ */

describe('compileRoutePath', () => {
  it('/index becomes /', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('/index')).toBe('/')
  })

  it('api/index becomes /api', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('api/index')).toBe('/api')
  })

  it('prefix is prepended', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('/users', { prefix: '/api' })).toBe('/api/users')
  })

  it('custom defaultSuffix works', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('/users/home', { defaultSuffix: '/home' })).toBe('/users')
  })

  it('path without leading slash gets one', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('api/test')).toBe('/api/test')
  })

  it('empty path after suffix removal becomes /', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('/index')).toBe('/')
  })

  it('defaultSuffix uses || (not ??) so empty string falls back', async () => {
    const { compileRoutePath } = await import('./index.js')
    expect(compileRoutePath('/foo', { defaultSuffix: '' })).toBe('/foo')
  })
})

/* ============ toRouterPath ============ */

describe('toRouterPath', () => {
  it('converts [id] to :id', async () => {
    const { toRouterPath } = await import('./index.js')
    expect(toRouterPath('/users/[id]')).toBe('/users/:id')
  })

  it('converts multiple params', async () => {
    const { toRouterPath } = await import('./index.js')
    expect(toRouterPath('/[category]/[id]')).toBe('/:category/:id')
  })

  it('returns path unchanged when no brackets', async () => {
    const { toRouterPath } = await import('./index.js')
    expect(toRouterPath('/users/list')).toBe('/users/list')
  })
})

/* ============ normalizePath ============ */

describe('normalizePath', () => {
  it('replaces backslashes with forward slashes', async () => {
    const { normalizePath } = await import('./index.js')
    expect(normalizePath('win\\path')).toBe('win/path')
  })

  it('removes parenthesized content', async () => {
    const { normalizePath } = await import('./index.js')
    expect(normalizePath('user/(group)/list')).toBe('user/list')
  })

  it('collapses duplicate slashes', async () => {
    const { normalizePath } = await import('./index.js')
    expect(normalizePath('api//test///endpoint')).toBe('api/test/endpoint')
  })
})

/* ============ scanDirectory ============ */

describe('scanDirectory', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hile-loader-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('returns empty array for empty directory', async () => {
    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler' })
    expect(result).toEqual([])
  })

  it('finds matching files', async () => {
    mkdirSync(join(tmp, 'users'), { recursive: true })
    writeFileSync(join(tmp, 'users', 'list.handler.js'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'users', 'get.handler.ts'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'ignore.txt'), 'nope', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler' })
    expect(result).toHaveLength(2)
    expect(result[0].relative).toBe('users/list.handler.js')
    expect(result[1].relative).toBe('users/get.handler.ts')
  })

  it('returns absolute paths', async () => {
    writeFileSync(join(tmp, 'test.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler' })
    expect(result[0].absolute).toBe(join(tmp, 'test.handler.js'))
  })

  it('compiles routePath with defaultSuffix = /index', async () => {
    writeFileSync(join(tmp, 'index.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler' })
    expect(result[0].routePath).toBe('/')
  })

  it('compiles routePath with prefix (root path produces trailing slash)', async () => {
    writeFileSync(join(tmp, 'index.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler', prefix: '/api' })
    expect(result[0].routePath).toBe('/api/')
  })

  it('does not return files with different suffix', async () => {
    writeFileSync(join(tmp, 'test.controller.js'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'test.msg.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { suffix: 'handler' })
    expect(result).toHaveLength(0)
  })

  it('uses default suffix "handler" when no options passed', async () => {
    writeFileSync(join(tmp, 'test.handler.js'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'test.other.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp)
    expect(result).toHaveLength(1)
    expect(result[0].relative).toBe('test.handler.js')
  })
})

/* ============ Loader base class ============ */

import { Loader } from './loader.js'
import type { ScannedFile } from './index.js'

class TestLoader extends Loader<{ value: string }> {
  public readonly registry = new Map<string, string>()

  constructor() {
    super({ suffix: 'test' })
  }

  protected bind(file: ScannedFile, mod: { value: string }) {
    this.registry.set(file.routePath, mod.value)
    return () => { this.registry.delete(file.routePath) }
  }
}

describe('Loader base class', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hile-loader-base-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('load() binds files and returns unregister function', async () => {
    writeFileSync(join(tmp, 'a.test.js'), `export default { value: 'hello' }`, 'utf8')

    const loader = new TestLoader()
    const unregister = await loader.load(tmp)

    expect(loader.registry.get('/a')).toBe('hello')

    unregister()
    expect(loader.registry.has('/a')).toBe(false)
  })

  it('skips files with no default export', async () => {
    writeFileSync(join(tmp, 'a.test.js'), `export const x = 1`, 'utf8')

    const loader = new TestLoader()
    await loader.load(tmp)

    expect(loader.registry.size).toBe(0)
  })

  it('multiple files are registered', async () => {
    writeFileSync(join(tmp, 'a.test.js'), `export default { value: 'a' }`, 'utf8')
    writeFileSync(join(tmp, 'b.test.js'), `export default { value: 'b' }`, 'utf8')

    const loader = new TestLoader()
    const unregister = await loader.load(tmp)

    expect(loader.registry.get('/a')).toBe('a')
    expect(loader.registry.get('/b')).toBe('b')

    unregister()
    expect(loader.registry.size).toBe(0)
  })

  it('unregister removes all entries regardless of load order', async () => {
    writeFileSync(join(tmp, 'a.test.js'), `export default { value: 'a' }`, 'utf8')
    writeFileSync(join(tmp, 'b.test.js'), `export default { value: 'b' }`, 'utf8')

    const loader = new TestLoader()
    const unregister = await loader.load(tmp)

    expect(loader.registry.size).toBe(2)
    unregister()
    expect(loader.registry.size).toBe(0)
  })

  it('works without constructor options (defaults to suffix=handler)', async () => {
    writeFileSync(join(tmp, 'b.handler.js'), `export default { value: 'ok' }`, 'utf8')

    class DefaultLoader extends Loader<{ value: string }> {
      public lastKey = ''
      protected bind(file: ScannedFile, mod: { value: string }) {
        this.lastKey = file.routePath
        return
      }
    }

    const loader = new DefaultLoader()
    await loader.load(tmp)
    expect(loader.lastKey).toBe('/b')
  })

  it('rolls back the current batch when a later binding fails', async () => {
    writeFileSync(join(tmp, 'a.test.js'), `export default { value: 'a' }`, 'utf8')
    writeFileSync(join(tmp, 'b.test.js'), `export default { value: 'fail' }`, 'utf8')
    class FailingLoader extends TestLoader {
      protected bind(file: ScannedFile, mod: { value: string }) {
        if (mod.value === 'fail') throw new Error('bind failed')
        return super.bind(file, mod)
      }
    }
    const loader = new FailingLoader()
    await expect(loader.load(tmp)).rejects.toThrow('bind failed')
    expect(loader.registry.size).toBe(0)
  })

  it('unloads batches independently and idempotently', async () => {
    const first = join(tmp, 'first')
    const second = join(tmp, 'second')
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'a.test.js'), `export default { value: 'a' }`, 'utf8')
    writeFileSync(join(second, 'b.test.js'), `export default { value: 'b' }`, 'utf8')
    const loader = new TestLoader()
    const unloadFirst = await loader.load(first)
    const unloadSecond = await loader.load(second)
    unloadFirst()
    unloadFirst()
    expect(loader.registry.has('/a')).toBe(false)
    expect(loader.registry.get('/b')).toBe('b')
    unloadSecond()
    expect(loader.registry.size).toBe(0)
  })
})
