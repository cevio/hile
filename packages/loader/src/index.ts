import { glob } from 'glob'
import { resolve, extname } from 'node:path'
import { parseFileRoute, type FileRoute } from './file-route.js'

export { Loader } from './loader.js'
export * from './file-route.js'

export interface ScannedFile {
  absolute: string
  relative: string
  routePath: string
}

export interface ScannedRouteFile extends ScannedFile {
  route: FileRoute
}

export interface ScanOptions {
  suffix?: string
  prefix?: string
  defaultSuffix?: string
  /** Reject matched modules that do not provide a default export. */
  requireDefault?: boolean
  /** Parse and validate the portable file-route DSL for routing consumers. */
  fileRoutes?: boolean
}

export interface FileRouteScanOptions extends ScanOptions {
  fileRoutes: true
}

export function isScannedRouteFile(file: ScannedFile): file is ScannedRouteFile {
  return 'route' in file && !!(file as ScannedRouteFile).route
}

/**
 * 将文件路径编译为标准 URL（不含动态参数转换）。
 * 供所有文件加载器共享前缀与默认入口处理规则。
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
 * 反斜杠转正斜杠、移除完整的括号路径段、合并连续斜杠。
 */
export function normalizePath(path: string): string {
  const normalized = path
    .replace(/\\/g, '/')
    .split('/')
    .filter(segment => !/^\([^)]+\)$/.test(segment))
    .join('/')
    .replace(/\/{2,}/g, '/')
  return normalized || (path.startsWith('/') ? '/' : '')
}

/**
 * 扫描目录，返回匹配后缀的文件列表及其编译后的路由路径。
 * glob pattern 包含 .ts/.js/.tsx/.jsx/.mjs。
 */
export function scanDirectory(
  directory: string,
  options: FileRouteScanOptions,
): Promise<ScannedRouteFile[]>
export function scanDirectory(
  directory: string,
  options?: ScanOptions,
): Promise<ScannedFile[]>
export async function scanDirectory(
  directory: string,
  options?: ScanOptions,
): Promise<(ScannedFile | ScannedRouteFile)[]> {
  const suffix = options?.suffix ?? 'handler'

  const files = await glob(`**/*.${suffix}.{ts,js,tsx,jsx,mjs}`, { cwd: directory })

  return files.map((file) => {
    const ext = extname(file)
    const url = file.slice(0, -(suffix.length + ext.length + 1))
    const baseRoutePath = compileRoutePath(url, { defaultSuffix: options?.defaultSuffix })
    const routePath = options?.prefix ? options.prefix + baseRoutePath : baseRoutePath
    return {
      absolute: resolve(directory, file),
      relative: file,
      routePath,
      ...(options?.fileRoutes
        ? { route: parseFileRoute(normalizePath(baseRoutePath), file) }
        : {}),
    }
  })
}
