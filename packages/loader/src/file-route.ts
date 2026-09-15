export type FileRouteSegment =
  | { readonly kind: 'static'; readonly value: string }
  | { readonly kind: 'parameter'; readonly name: string }
  | { readonly kind: 'catch-all'; readonly name: string }

export interface FileRoute {
  readonly path: string
  readonly segments: readonly FileRouteSegment[]
}

export enum FileRouteBackend {
  FindMyWay = 'find-my-way',
  Rou3 = 'rou3',
}

export interface CompiledFileRoute {
  path: string
  shape: string
  catchAllName?: string
}

interface CompiledRoutePrefix {
  path: string
  shape: string
  parameterNames: readonly string[]
}

interface RouterPathAnalysis {
  shape: string
  parameterNames: readonly string[]
}

export interface CompileFileRouteOptions {
  prefix?: string
}

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const nativeSyntax = /[:*?{}]/
const nativeRouteSyntax = /[:*?{}()]/
const parsedRoutes = new WeakSet<FileRoute>()
const unsafePropertyNames = new Set(['__proto__', 'prototype', 'constructor'])

function invalid(path: string, source: string | undefined, reason: string): never {
  const context = source ? ` in ${source}` : ''
  throw new TypeError(`Invalid file route ${JSON.stringify(path)}${context}: ${reason}`)
}

function assertBackend(backend: FileRouteBackend): void {
  switch (backend) {
    case FileRouteBackend.FindMyWay:
    case FileRouteBackend.Rou3:
      return
    default:
      throw new TypeError(`Unsupported file route backend: ${String(backend)}`)
  }
}

function claimDynamicName(names: Set<string>, name: string, path: string, source?: string) {
  if (unsafePropertyNames.has(name)) {
    invalid(path, source, `dynamic parameter name ${JSON.stringify(name)} is not allowed`)
  }
  if (names.has(name)) invalid(path, source, `dynamic parameter name ${JSON.stringify(name)} is duplicated`)
  names.add(name)
}

function canonicalPath(segments: readonly FileRouteSegment[]): string {
  return '/' + segments.map((segment) => {
    if (segment.kind === 'static') return segment.value
    if (segment.kind === 'parameter') return `[${segment.name}]`
    return `[...${segment.name}]`
  }).join('/')
}

function closingParenthesis(path: string, opening: number): number {
  let depth = 1
  for (let index = opening + 1; index < path.length; index++) {
    if (path[index] === '\\') {
      index++
      continue
    }
    if (path[index] === '(') depth++
    if (path[index] === ')' && --depth === 0) return index
  }
  return path.length - 1
}

function nativeParameterTokens(segment: string): Array<{ start: number; end: number; name: string }> {
  const tokens: Array<{ start: number; end: number; name: string }> = []
  for (let index = 0; index < segment.length; index++) {
    if (segment[index] === '(') {
      index = closingParenthesis(segment, index)
      continue
    }
    if (segment[index] === ':' && segment[index + 1] === ':') {
      index++
      continue
    }
    if (segment[index] !== ':') continue
    let end = index + 1
    while (end < segment.length && !/[().\-?]/.test(segment[end])) end++
    tokens.push({ start: index, end, name: segment.slice(index + 1, end) })
    index = end - 1
  }
  return tokens
}

function rou3ParameterTokens(segment: string): Array<{ start: number; end: number; name: string }> {
  const tokens: Array<{ start: number; end: number; name: string }> = []
  for (let index = 0; index < segment.length; index++) {
    if (segment[index] === '\\') {
      index++
      continue
    }
    if (segment[index] === '(') {
      index = closingParenthesis(segment, index)
      continue
    }
    if (segment[index] !== ':' || !/[A-Za-z0-9_-]/.test(segment[index + 1] || '')) continue
    let end = index + 2
    while (end < segment.length && /[A-Za-z0-9_-]/.test(segment[end])) end++
    tokens.push({ start: index, end, name: segment.slice(index + 1, end) })
    index = end - 1
  }
  return tokens
}

function analyzeRou3Path(path: string): RouterPathAnalysis {
  const parameterNames: string[] = []
  const shapeSegments = path.split('/').filter(Boolean).map((segment) => {
    if (segment === '*') return 'p'
    if (segment.startsWith('**')) return 'c'
    const tokens = rou3ParameterTokens(segment)
    parameterNames.push(...tokens.map(token => token.name))
    parameterNames.push(...rou3NamedCaptureNames(segment))
    if (!tokens.length) return `s:${segment}`
    if (tokens.length === 1 && tokens[0].start === 0 && tokens[0].end === segment.length) return 'p'
    let normalized = ''
    let cursor = 0
    for (const token of tokens) {
      normalized += segment.slice(cursor, token.start) + ':p'
      cursor = token.end
    }
    normalized += segment.slice(cursor)
    return `n:${normalized}`
  })
  return {
    shape: `${path.startsWith('/') ? '/' : ''}${shapeSegments.join('/')}`,
    parameterNames,
  }
}

function rou3NamedCaptureNames(segment: string): string[] {
  const names: string[] = []
  for (let index = 0; index < segment.length; index++) {
    if (segment[index] === '\\') {
      index++
      continue
    }
    if (segment[index] !== '(' || segment[index + 1] !== '?' || segment[index + 2] !== '<') continue
    const start = index + 3
    if (!/[A-Za-z_$]/.test(segment[start] || '')) continue
    let end = start + 1
    while (end < segment.length && /[A-Za-z0-9_$]/.test(segment[end])) end++
    if (segment[end] === '>') names.push(segment.slice(start, end))
  }
  return names
}

function analyzeBackendPath(path: string, backend: FileRouteBackend): RouterPathAnalysis {
  return backend === FileRouteBackend.FindMyWay
    ? analyzeRouterPath(path)
    : analyzeRou3Path(path)
}

function joinRouteShapes(prefix: CompiledRoutePrefix, routeShape: string): string {
  if (!prefix.path) return routeShape
  return routeShape === '/' ? prefix.shape : `${prefix.shape}${routeShape}`
}

export function toRouterPath(path: string): string {
  let compiled = ''
  let parentheses = 0
  for (let index = 0; index < path.length; index++) {
    const character = path[index]
    if (character === '\\') {
      compiled += character + (path[index + 1] || '')
      index++
      continue
    }
    if (character === '(') parentheses++
    else if (character === ')' && parentheses > 0) parentheses--
    if (character !== '[' || parentheses > 0) {
      compiled += character
      continue
    }
    const closing = path.indexOf(']', index + 1)
    if (closing < 0) {
      compiled += character
      continue
    }
    compiled += `:${path.slice(index + 1, closing)}`
    index = closing
  }
  return compiled
}

function hasFindMyWayWildcard(path: string): boolean {
  let parentheses = 0
  for (let index = 0; index < path.length; index++) {
    if (path[index] === '(') parentheses++
    else if (path[index] === ')' && parentheses > 0) parentheses--
    else if (path[index] === '*' && parentheses === 0) return true
  }
  return false
}

function hasRou3CatchAll(path: string): boolean {
  return path.split('/').some(segment => {
    if (segment.startsWith('**')) return true
    if (!segment.endsWith('+') && !segment.endsWith('*')) return false
    return rou3ParameterTokens(segment).length > 0
  })
}

/** Analyze router-native parameter tokens without treating regex contents as route syntax. */
function analyzeRouterPath(path: string): RouterPathAnalysis {
  const parameterNames: string[] = []
  const shapeSegments = path.split('/').filter(Boolean).map((segment) => {
    if (segment === '*') return 'c'
    const tokens = nativeParameterTokens(segment)
    parameterNames.push(...tokens.map(token => token.name))
    if (!tokens.length) return `s:${segment}`
    if (tokens.length === 1 && tokens[0].start === 0 && tokens[0].end === segment.length) return 'p'
    let cursor = 0
    let normalized = ''
    for (const token of tokens) {
      normalized += segment.slice(cursor, token.start) + ':p'
      cursor = token.end
    }
    normalized += segment.slice(cursor)
    return `n:${normalized}`
  })
  return {
    shape: `${path.startsWith('/') ? '/' : ''}${shapeSegments.join('/')}`,
    parameterNames,
  }
}

/** Compile a configured router prefix while preserving native syntax. */
function compileRoutePrefix(prefix: string, backend: FileRouteBackend): CompiledRoutePrefix {
  assertBackend(backend)
  if (!prefix) return { path: '', shape: '', parameterNames: [] }
  if ((backend === FileRouteBackend.FindMyWay && hasFindMyWayWildcard(prefix))
    || (backend === FileRouteBackend.Rou3 && hasRou3CatchAll(prefix))) {
    invalid(prefix, undefined, 'prefix cannot contain a catch-all')
  }

  const parameterNames = new Set<string>()
  const segments: string[] = []
  for (const segment of prefix.split('/')) {
    if (!segment || /^\([^)]+\)$/.test(segment)) continue
    if (!nativeRouteSyntax.test(segment) && (segment.includes('[') || segment.includes(']'))) {
      const parsed = parseFileRoute(`/${segment}`)
      const item = parsed.segments[0]
      if (!item || item.kind === 'static') {
        segments.push(segment)
        continue
      }
      if (item.kind === 'catch-all') invalid(prefix, undefined, 'prefix cannot contain a catch-all')
      segments.push(`:${item.name}`)
      continue
    }
    segments.push(segment)
  }
  const path = `${prefix.startsWith('/') ? '/' : ''}${segments.join('/')}`
  const normalizedPath = path === '/' ? '' : path
  const analysis = analyzeBackendPath(normalizedPath, backend)
  for (const name of analysis.parameterNames) claimDynamicName(parameterNames, name, prefix)
  return {
    path: normalizedPath,
    shape: analysis.shape,
    parameterNames: [...parameterNames],
  }
}

/** Compile a direct route that may mix legacy bracket parameters with router-native syntax. */
export function compileCompatibleRoutePath(
  path: string,
  backend: FileRouteBackend,
  options: CompileFileRouteOptions = {},
): CompiledFileRoute {
  assertBackend(backend)
  if (!path.startsWith('/')) invalid(path, undefined, 'route must be absolute')

  const rawSegments = path.split('/')
  const effectiveSegments = rawSegments.filter(segment => segment && !/^\([^)]+\)$/.test(segment))
  let catchAllName: string | undefined
  const segments = effectiveSegments.map((segment, index) => {
    const catchAll = segment.match(/^\[\.\.\.([^\]]+)\]$/)
    if (catchAll) {
      const name = catchAll[1]
      if (!identifier.test(name)) invalid(path, undefined, 'catch-all name must be a safe identifier')
      if (index !== effectiveSegments.length - 1) invalid(path, undefined, 'catch-all must be the final path segment')
      catchAllName = name
      return backend === FileRouteBackend.FindMyWay ? '*' : `**:${name}`
    }
    return toRouterPath(segment)
  })

  const routePath = '/' + segments.join('/')
  const prefix = compileRoutePrefix(options.prefix || '', backend)
  const compiledPath = `${prefix.path}${routePath}`
  const routeAnalysis = analyzeBackendPath(routePath, backend)
  const names = new Set<string>()
  for (const name of prefix.parameterNames) claimDynamicName(names, name, path)
  for (const name of routeAnalysis.parameterNames) claimDynamicName(names, name, path)
  if (catchAllName) claimDynamicName(names, catchAllName, path)
  return {
    path: compiledPath,
    shape: joinRouteShapes(prefix, routeAnalysis.shape),
    ...(catchAllName ? { catchAllName } : {}),
  }
}

function validateFileRoute(route: FileRoute): FileRoute {
  if (parsedRoutes.has(route)) return route
  const displayPath = route && typeof route.path === 'string' ? route.path : '/'
  if (!route || typeof route.path !== 'string') {
    invalid(displayPath, undefined, 'path must be a string')
  }
  if (!Array.isArray(route.segments)) {
    invalid(displayPath, undefined, 'segments must be an array')
  }

  const serialized = '/' + (route.segments as readonly unknown[]).map((segment) => {
    if (!segment || typeof segment !== 'object') {
      invalid(displayPath, undefined, 'each segment must be an object')
    }
    const value = segment as Record<string, unknown>
    if (value.kind === 'static' && typeof value.value === 'string') return value.value
    if (value.kind === 'parameter' && typeof value.name === 'string') return `[${value.name}]`
    if (value.kind === 'catch-all' && typeof value.name === 'string') return `[...${value.name}]`
    invalid(displayPath, undefined, 'segment kind and fields are invalid')
  }).join('/')

  const parsed = parseFileRoute(serialized)
  const sameSegments = parsed.segments.length === route.segments.length
    && parsed.segments.every((segment, index) => {
      const original = route.segments[index]
      if (segment.kind !== original.kind) return false
      if (segment.kind === 'static') return original.kind === 'static' && segment.value === original.value
      return original.kind !== 'static' && segment.name === original.name
    })
  if (!sameSegments) invalid(displayPath, undefined, 'segments are not canonical')
  if (route.path !== parsed.path) invalid(displayPath, undefined, 'path does not match segments')
  return parsed
}

/** Parse the portable Hile file-route DSL without accepting router-native syntax. */
export function parseFileRoute(path: string, source?: string): FileRoute {
  if (!path.startsWith('/')) invalid(path, source, 'route must be absolute')

  const rawSegments = path.split('/').filter(Boolean)
  const segments: FileRouteSegment[] = []
  const dynamicNames = new Set<string>()

  const claim = (name: string) => claimDynamicName(dynamicNames, name, path, source)

  for (let index = 0; index < rawSegments.length; index++) {
    const segment = rawSegments[index]
    if (segment === '.' || segment === '..') invalid(path, source, 'dot segments are not supported')
    if (segment.startsWith('[[...') || segment.endsWith(']]')) {
      invalid(path, source, 'optional catch-all segments are not supported')
    }

    const dynamic = segment.match(/^\[([^\]]+)\]$/)
    if (dynamic) {
      const value = dynamic[1]
      if (value.startsWith('...')) {
        const name = value.slice(3)
        if (!identifier.test(name)) invalid(path, source, 'catch-all name must be a safe identifier')
        claim(name)
        if (index !== rawSegments.length - 1) {
          invalid(path, source, 'catch-all must be the final path segment')
        }
        segments.push({ kind: 'catch-all', name })
        continue
      }
      if (!identifier.test(value)) invalid(path, source, 'parameter name must be a safe identifier')
      claim(value)
      segments.push({ kind: 'parameter', name: value })
      continue
    }

    if (segment.includes('[') || segment.includes(']')) {
      invalid(path, source, 'dynamic segments must occupy the complete path segment')
    }
    if (nativeSyntax.test(segment) || segment.includes('(') || segment.includes(')')) {
      invalid(path, source, 'router-native syntax is not supported in file names')
    }
    segments.push({ kind: 'static', value: segment })
  }

  const frozenSegments = Object.freeze(segments.map(segment => Object.freeze(segment)))
  const route = Object.freeze({
    path: canonicalPath(frozenSegments),
    segments: frozenSegments,
  })
  parsedRoutes.add(route)
  return route
}

/** Compile one parsed file route for the selected routing backend. */
export function compileFileRoute(
  route: FileRoute,
  backend: FileRouteBackend,
  options: CompileFileRouteOptions = {},
): CompiledFileRoute {
  assertBackend(backend)
  const validated = validateFileRoute(route)
  const prefix = compileRoutePrefix(options.prefix || '', backend)
  const prefixNames = new Set(prefix.parameterNames)
  for (const segment of validated.segments) {
    if (segment.kind !== 'static' && prefixNames.has(segment.name)) {
      invalid(`${prefix.path}${validated.path}`, undefined,
        `dynamic parameter name ${JSON.stringify(segment.name)} is duplicated`)
    }
  }
  let catchAllName: string | undefined
  const routePath = '/' + validated.segments.map((segment) => {
    if (segment.kind === 'static') return segment.value
    if (segment.kind === 'parameter') return `:${segment.name}`
    catchAllName = segment.name
    return backend === FileRouteBackend.FindMyWay ? '*' : `**:${segment.name}`
  }).join('/')
  const path = `${prefix.path}${routePath}`
  const routeAnalysis = analyzeBackendPath(routePath, backend)

  return {
    path,
    shape: joinRouteShapes(prefix, routeAnalysis.shape),
    ...(catchAllName ? { catchAllName } : {}),
  }
}
