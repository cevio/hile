import { glob } from 'glob'
import { resolve, extname } from 'node:path'

export { Loader } from './loader.js'

export interface ScannedFile {
  absolute: string
  relative: string
  routePath: string
}

export interface ScanOptions {
  suffix?: string
  prefix?: string
  defaultSuffix?: string
  /** Reject matched modules that do not provide a default export. */
  requireDefault?: boolean
}

/**
 * 将文件路径编译为标准 URL（不含动态参数转换）。
 * 算法逐行对应 @hile/http/loader.ts 与 @hile/message-loader 的私有实现。
 */
export function compileRoutePath(
  path: string,
  options?: { defaultSuffix?: string; prefix?: string },
): string {
  const defaultSuffix = options?.defaultSuffix || '/index'
  let url = path.startsWith('/') ? path : '/' + path
  if (url.endsWith(defaultSuffix)) {
    url = url.substring(0, url.length - defaultSuffix.length)
  }
  if (!url) url = '/'
  return options?.prefix ? options.prefix + url : url
}

/**
 * 将 [param] 格式参数转换为 :param（find-my-way / rou3 兼容）。
 */
export function toRouterPath(path: string): string {
  return path.replace(/\[([^\]]+)\]/g, ':$1')
}

/**
 * 反斜杠转正斜杠、移除括号内容、合并连续斜杠。
 */
export function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\([^)]+\)/g, '').replace(/\/{2,}/g, '/')
}

/**
 * 扫描目录，返回匹配后缀的文件列表及其编译后的路由路径。
 * glob pattern 包含 .ts/.js/.tsx/.jsx/.mjs。
 */
export async function scanDirectory(
  directory: string,
  options?: ScanOptions,
): Promise<ScannedFile[]> {
  const suffix = options?.suffix ?? 'handler'

  const files = await glob(`**/*.${suffix}.{ts,js,tsx,jsx,mjs}`, { cwd: directory })

  return files.map((file) => {
    const ext = extname(file)
    const url = file.slice(0, -(suffix.length + ext.length + 1))
    return {
      absolute: resolve(directory, file),
      relative: file,
      routePath: compileRoutePath(url, options),
    }
  })
}
