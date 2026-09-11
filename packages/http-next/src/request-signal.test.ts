import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { getHttpNextRequestSignal } from './request-signal'
import { requestSignals } from './request-signal-storage'

describe('HttpNext request signal entrypoint', () => {
  it('publishes the Next-free request signal subpath with runtime and type entries', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    ))

    expect(packageJson.exports['./request-signal']).toEqual({
      types: './dist/request-signal.d.ts',
      import: './dist/request-signal.js',
    })
    expect(packageJson.exports['./dist/index.js']).toBe('./dist/index.js')
    expect(packageJson.exports['./dist/index.d.ts']).toBe('./dist/index.d.ts')
    expect(packageJson.exports['./package.json']).toBe('./package.json')
    expect(packageJson.exports['./request-signal-storage']).toBeUndefined()
  })

  it('shares one request signal only inside the bound asynchronous context', async () => {
    const signal = new AbortController().signal

    expect(getHttpNextRequestSignal()).toBeUndefined()
    await requestSignals.run(signal, async () => {
      expect(getHttpNextRequestSignal()).toBe(signal)
      await Promise.resolve()
      expect(getHttpNextRequestSignal()).toBe(signal)
    })
    expect(getHttpNextRequestSignal()).toBeUndefined()
  })

  it('isolates concurrent request contexts sharing one process storage', async () => {
    const first = new AbortController().signal
    const second = new AbortController().signal

    const observed = await Promise.all([
      requestSignals.run(first, async () => {
        await new Promise<void>((resolve) => setImmediate(resolve))
        return getHttpNextRequestSignal()
      }),
      requestSignals.run(second, async () => {
        await Promise.resolve()
        return getHttpNextRequestSignal()
      }),
    ])

    expect(observed).toEqual([first, second])
    expect(getHttpNextRequestSignal()).toBeUndefined()
  })

  it('reuses the process-wide storage after the module is reloaded', async () => {
    const firstModule = await import('./request-signal')
    vi.resetModules()
    const reloadedModule = await import('./request-signal')
    const signal = new AbortController().signal

    expect(requestSignals.run(
      signal,
      () => reloadedModule.getHttpNextRequestSignal(),
    )).toBe(signal)
  })
})
