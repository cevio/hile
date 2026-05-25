import { pathToFileURL } from 'node:url'
import type { ScannedFile, ScanOptions } from './index.js'
import { scanDirectory } from './index.js'

export abstract class Loader<TFile, TOptions extends ScanOptions = ScanOptions> {
  protected readonly options: TOptions
  private unregisters: (() => void)[] = []

  constructor(options?: TOptions) {
    this.options = (options ?? {}) as TOptions
  }

  /** 子类实现：将单个文件的 default export 绑定到路由/调度系统。返回注销函数。 */
  protected abstract bind(file: ScannedFile, module: TFile): (() => void) | void

  /** 批量从目录加载，返回批量注销函数。 */
  async load(directory: string): Promise<() => void> {
    const files = await scanDirectory(directory, this.options)

    for (const file of files) {
      const href = pathToFileURL(file.absolute).href
      const mod: { default?: TFile } = await import(href)
      if (mod.default == null) continue

      const unregister = this.bind(file, mod.default)
      if (unregister) {
        this.unregisters.push(unregister)
      }
    }

    return () => {
      let i = this.unregisters.length
      while (i--) {
        this.unregisters[i]()
      }
      this.unregisters.length = 0
    }
  }
}
