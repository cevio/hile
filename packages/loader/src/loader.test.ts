import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { FileRouteBackend } from './file-route.js'

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

  it('only converts complete portable segments and preserves native regex classes', async () => {
    const { toRouterPath } = await import('./index.js')
    expect(toRouterPath('/:tenant/users/[id]')).toBe('/:tenant/users/:id')
    expect(toRouterPath('/codes/:id([0-9]+)')).toBe('/codes/:id([0-9]+)')
  })

  it('preserves the legacy mixed parameter conversion outside native regexes', async () => {
    const { toRouterPath } = await import('./index.js')
    expect(toRouterPath('/files/[id].json')).toBe('/files/:id.json')
    expect(toRouterPath('/:kind([a-z]+)/[id].json')).toBe('/:kind([a-z]+)/:id.json')
  })
})

/* ============ file route DSL ============ */

describe('file route DSL', () => {
  it('parses static, parameter, and required catch-all segments into one structure', async () => {
    const { parseFileRoute } = await import('./index.js')
    expect(parseFileRoute('/assets/[tenant]/[...paths]')).toEqual({
      path: '/assets/[tenant]/[...paths]',
      segments: [
        { kind: 'static', value: 'assets' },
        { kind: 'parameter', name: 'tenant' },
        { kind: 'catch-all', name: 'paths' },
      ],
    })
  })

  it('compiles the same route structure for find-my-way and rou3', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/assets/[tenant]/[...paths]')
    expect(compileFileRoute(route, FileRouteBackend.FindMyWay)).toEqual({
      path: '/assets/:tenant/*',
      shape: '/s:assets/p/c',
      catchAllName: 'paths',
    })
    expect(compileFileRoute(route, FileRouteBackend.Rou3)).toEqual({
      path: '/assets/:tenant/**:paths',
      shape: '/s:assets/p/c',
      catchAllName: 'paths',
    })
  })

  it('compiles bracket-style prefixes and rejects duplicate full-route parameter names', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/users/[id]')
    expect(compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/[tenant]' }).path)
      .toBe('/:tenant/users/:id')
    expect(compileFileRoute(route, FileRouteBackend.Rou3, { prefix: '/[tenant]' }).path)
      .toBe('/:tenant/users/:id')
    expect(() => compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/:id' }))
      .toThrow(/duplicated/)
  })

  it('ignores regex-internal colons and rejects object-meta names in native prefixes', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/users/[foo]')
    expect(compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/:id((?:foo)(?:foo))' }).path)
      .toBe('/:id((?:foo)(?:foo))/users/:foo')
    expect(() => compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/:__proto__' }))
      .toThrow(/not allowed/)
  })

  it('follows backend-specific native prefix parameter syntax', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/users/[tenant]')

    expect(compileFileRoute(route, FileRouteBackend.Rou3, { prefix: '/:tenant-id' }).path)
      .toBe('/:tenant-id/users/:tenant')
    expect(compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/:123' }).path)
      .toBe('/:123/users/:tenant')
    expect(compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/:value(.*)::tenant' }).path)
      .toBe('/:value(.*)::tenant/users/:tenant')

    const rou3Route = parseFileRoute('/users/[foo]')
    expect(compileFileRoute(rou3Route, FileRouteBackend.Rou3, {
      prefix: '/:id((?:foo)(?:foo))',
    }).path).toBe('/:id((?:foo)(?:foo))/users/:foo')
    expect(() => compileFileRoute(rou3Route, FileRouteBackend.Rou3, {
      prefix: '/:id((?<foo>foo))',
    })).toThrow(/duplicated/)
    expect(() => compileFileRoute(route, FileRouteBackend.Rou3, {
      prefix: '/:id((?<constructor>foo))',
    })).toThrow(/not allowed/)
    expect(compileFileRoute(rou3Route, FileRouteBackend.Rou3, {
      prefix: '/\\(?<foo>',
    }).path).toBe('/\\(?<foo>/users/:foo')
  })

  it('rejects router-native catch-alls in prefixes for both backends', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/users/[id]')

    expect(() => compileFileRoute(route, FileRouteBackend.FindMyWay, { prefix: '/*' }))
      .toThrow(/prefix cannot contain a catch-all/)
    expect(() => compileFileRoute(route, FileRouteBackend.Rou3, { prefix: '/**:rest' }))
      .toThrow(/prefix cannot contain a catch-all/)
    expect(compileFileRoute(route, FileRouteBackend.Rou3, { prefix: '/\\:name+' }).path)
      .toBe('/\\:name+/users/:id')
  })

  it('rejects a repeated catch-all declaration before router registration', async () => {
    const { compileCompatibleRoutePath } = await import('./index.js')
    expect(() => compileCompatibleRoutePath(
      '/[...paths]/x/[...paths]',
      FileRouteBackend.FindMyWay,
    )).toThrow(/catch-all must be the final path segment/)
  })

  it('rejects a forged route AST before compiling router syntax', async () => {
    const { compileFileRoute } = await import('./index.js')
    const forged = {
      path: '/users/[id]',
      segments: [{ kind: 'parameter', name: "id'];globalThis.compromised=true;params['x" }],
    }
    expect(() => compileFileRoute(forged as any, FileRouteBackend.FindMyWay)).toThrow(/Invalid file route/)
  })

  it.each([
    [{ path: '/admin', segments: [{ kind: 'static', value: 'public' }] }],
    [{ segments: [{ kind: 'static', value: 'public' }] }],
  ])('rejects a route AST whose canonical path is inconsistent', async (forged) => {
    const { compileFileRoute } = await import('./index.js')
    expect(() => compileFileRoute(forged as any, FileRouteBackend.Rou3)).toThrow(/Invalid file route/)
  })

  it('uses collision-proof shapes for static text that resembles DSL markers', async () => {
    const { compileFileRoute, parseFileRoute } = await import('./index.js')
    expect(compileFileRoute(parseFileRoute('/files/...'), FileRouteBackend.Rou3).shape)
      .not.toBe(compileFileRoute(parseFileRoute('/files/[...paths]'), FileRouteBackend.Rou3).shape)
  })

  it('returns a deeply immutable parsed route', async () => {
    const { parseFileRoute } = await import('./index.js')
    const route = parseFileRoute('/assets/[tenant]/[...paths]')
    expect(Object.isFrozen(route)).toBe(true)
    expect(Object.isFrozen(route.segments)).toBe(true)
    expect(route.segments.every(Object.isFrozen)).toBe(true)
  })

  it.each([
    ['relative route', 'files/[id]'],
    ['dot segment', '/files/../[id]'],
    ['optional catch-all', '/files/[[...paths]]'],
    ['non-terminal catch-all', '/files/[...paths]/edit'],
    ['mixed catch-all segment', '/files/prefix[...paths]'],
    ['mixed parameter segment', '/users/prefix[id]'],
    ['empty catch-all name', '/files/[...]'],
    ['unsafe catch-all name', '/files/[...path-name]'],
    ['unsafe parameter name', '/users/[user-name]'],
    ['prototype-mutating parameter name', '/users/[__proto__]'],
    ['prototype constructor catch-all name', '/files/[...constructor]'],
    ['duplicate parameter name', '/teams/[id]/users/[id]'],
    ['parameter and catch-all name collision', '/files/[paths]/[...paths]'],
    ['native named parameter', '/users/:id'],
    ['native wildcard', '/files/*'],
    ['native optional syntax', '/files/:path?'],
    ['native braces', '/files/{path}'],
    ['native regex', '/files/[id](digits)'],
  ])('rejects %s with source context', async (_label, path) => {
    const { parseFileRoute } = await import('./index.js')
    expect(() => parseFileRoute(path, 'controllers/example.controller.ts'))
      .toThrow(/controllers\/example\.controller\.ts/)
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

  it('normalizes an absolute route containing only a group to root', async () => {
    const { normalizePath } = await import('./index.js')
    expect(normalizePath('/(admin)')).toBe('/')
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

  it('ignores declaration files and source maps that resemble handlers', async () => {
    writeFileSync(join(tmp, 'valid.handler.js'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'types.handler.d.ts'), 'export default {}', 'utf8')
    writeFileSync(join(tmp, 'valid.handler.js.map'), '{}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp)
    expect(result.map(file => file.relative)).toEqual(['valid.handler.js'])
  })

  it('validates route syntax during scanning and identifies the file', async () => {
    mkdirSync(join(tmp, 'files', '[...paths]'), { recursive: true })
    writeFileSync(join(tmp, 'files', '[...paths]', 'edit.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    await expect(scanDirectory(tmp, { fileRoutes: true })).rejects.toThrow(/files\/\[\.\.\.paths\]\/edit\.handler\.js/)
  })

  it('does not erase router-native regex syntax before validating a file route', async () => {
    mkdirSync(join(tmp, 'users'), { recursive: true })
    writeFileSync(join(tmp, 'users', '[id](digits).handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    await expect(scanDirectory(tmp, { fileRoutes: true })).rejects.toThrow(/users\/\[id\]\(digits\)\.handler\.js/)
  })

  it('does not apply route syntax restrictions unless requested by a route consumer', async () => {
    writeFileSync(join(tmp, 'plain:{name}.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp)
    expect(result).toHaveLength(1)
    expect(result[0]).not.toHaveProperty('route')
  })

  it('returns a required route AST when a route consumer opts in', async () => {
    mkdirSync(join(tmp, 'users'))
    writeFileSync(join(tmp, 'users', '[id].handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { fileRoutes: true, prefix: '/:tenant' })
    expect(result[0].route.path).toBe('/users/[id]')
    expect(result[0].routePath).toBe('/:tenant/users/[id]')
  })

  it('maps a grouped index file to the root route when file routes are enabled', async () => {
    mkdirSync(join(tmp, '(admin)'))
    writeFileSync(join(tmp, '(admin)', 'index.handler.js'), 'export default {}', 'utf8')

    const { scanDirectory } = await import('./index.js')
    const result = await scanDirectory(tmp, { fileRoutes: true })
    expect(result[0].route.path).toBe('/')
  })

  it('keeps a compiled [...paths] controller in the actual npm pack manifest', () => {
    mkdirSync(join(tmp, 'dist', 'controllers'), { recursive: true })
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'hile-catch-all-pack-fixture',
      version: '1.0.0',
      files: ['dist'],
    }), 'utf8')
    writeFileSync(join(tmp, 'dist', 'controllers', '[...paths].controller.js'),
      'export default {}\n', 'utf8')
    const args = ['pack', '--dry-run', '--json', '--ignore-scripts']
    const command = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm'
    const commandArgs = process.platform === 'win32' ? ['/d', '/s', '/c', `npm ${args.join(' ')}`] : args
    const output = execFileSync(command, commandArgs, {
      cwd: tmp,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: join(tmp, '.npm-cache') },
    })
    const manifest = JSON.parse(output)
    expect(manifest[0].files.map((file: { path: string }) => file.path))
      .toContain('dist/controllers/[...paths].controller.js')
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
