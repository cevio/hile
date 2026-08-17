import { afterEach, describe, expect, it, vi } from 'vitest'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { HttpNext } from './index'

describe('HttpNext integration', () => {
  let stop: (() => Promise<void>) | undefined
  let socket: WebSocket | undefined

  afterEach(async () => {
    socket?.close()
    socket = undefined
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

    socket = new WebSocket(`${origin.replace('http:', 'ws:')}/_next/hmr?id=http-next-stop-test`)
    await waitForWebSocket(socket, 'open')

    await withTimeout(stop(), 5_000, 'HttpNext stop timed out with an active HMR WebSocket')
    stop = undefined
    if (socket.readyState !== WebSocket.CLOSED) {
      await waitForWebSocket(socket, 'close')
    }
    expect(socket.readyState).toBe(WebSocket.CLOSED)
  }, 60_000)
})

function waitForWebSocket(socket: WebSocket, event: 'open' | 'close'): Promise<void> {
  return withTimeout(new Promise<void>((resolve, reject) => {
    socket.addEventListener(event, () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${event} failed`)), {
      once: true,
    })
  }), 5_000, `WebSocket ${event} timed out`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
