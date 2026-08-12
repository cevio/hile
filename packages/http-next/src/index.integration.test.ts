import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { HttpNext } from './index'

describe('HttpNext integration', () => {
  let stop: (() => Promise<void>) | undefined

  afterEach(async () => {
    await stop?.()
    stop = undefined
    vi.unstubAllEnvs()
  })

  it('在单一 HTTP server 上运行 Next App Router、RSC 与静态资源', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const fixture = resolve(packageRoot, 'fixtures/app')

    let origin = ''
    const app = new HttpNext({ port: 0, cwd: fixture })
    stop = await app.start((server) => {
      const address = server.address() as AddressInfo
      origin = `http://127.0.0.1:${address.port}`
    })

    const page = await fetch(origin)
    const html = await page.text()
    expect(page.status).toBe(200)
    expect(html).toContain('server-value')
    expect(html).toContain('client-value')
    expect(html).toContain('self.__next_f.push')

    const assetPath = html.match(/src="([^\"]*\/_next\/static\/[^\"]+\.js[^\"]*)"/)?.[1]
    expect(assetPath).toBeTruthy()
    const asset = await fetch(new URL(assetPath!, origin))
    expect(asset.status).toBe(200)

    const publicFile = await fetch(`${origin}/probe.txt`)
    expect(publicFile.status).toBe(200)
    expect(await publicFile.text()).toBe('public-value\n')
  }, 60_000)
})
