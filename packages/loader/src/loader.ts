import { pathToFileURL } from 'node:url'
import type { ScannedFile, ScanOptions } from './index.js'
import { scanDirectory } from './index.js'

export abstract class Loader<TFile, TOptions extends ScanOptions = ScanOptions> {
  protected readonly options: TOptions
  private readonly unregisters = new Set<() => void>()

  constructor(options?: TOptions) {
    this.options = (options ?? {}) as TOptions
  }

  /** 子类实现：将单个文件的 default export 绑定到路由/调度系统。返回注销函数。 */
  protected abstract bind(file: ScannedFile, module: TFile): (() => void) | void

  /** 批量从目录加载，返回批量注销函数。 */
  async load(directory: string, options: { cacheBust?: string | number } = {}): Promise<() => void> {
    const files = await scanDirectory(directory, this.options)
    const batch: (() => void)[] = []
    try {
      for (const file of files) {
        const url = new URL(pathToFileURL(file.absolute))
        if (options.cacheBust !== undefined) url.searchParams.set('v', String(options.cacheBust))
        const mod: { default?: TFile } = await import(url.href)
        if (mod.default == null) {
          if (this.options.requireDefault) throw new TypeError(`${file.relative} must have a default export`)
          continue
        }

        const unregister = this.bind(file, mod.default)
        if (unregister) {
          batch.push(unregister)
          this.unregisters.add(unregister)
        }
      }
    } catch (error) {
      const cleanupErrors: unknown[] = []
      for (const unregister of batch.reverse()) {
        this.unregisters.delete(unregister)
        try { unregister() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError([error, ...cleanupErrors], 'Loader failed and rollback was incomplete')
      }
      throw error
    }

    let unloaded = false
    return () => {
      if (unloaded) return
      unloaded = true
      const errors: unknown[] = []
      for (const unregister of batch.reverse()) {
        if (!this.unregisters.delete(unregister)) continue
        try { unregister() } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Loader unload failed')
    }
  }
}
