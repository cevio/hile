---
name: hile-http
description: @hile/http 的代码生成与使用规范。适用于路由、控制器、中间件、文件系统自动路由及与 @hile/core 的集成场景。
---

# @hile/http SKILL

本文档用于规范 AI 与开发者在 `@hile/http` 中的实现方式，确保控制器形式、路由加载与服务生命周期管理一致。

## 1. 架构概览

`@hile/http` 由三部分组成：

- `Http`：封装 Koa 与路由器，负责中间件、路由注册与服务启停
- `defineController`：将方法、可选中间件与处理函数封装为标准控制器
- `Loader`：支持手动编译路由与按文件系统自动加载，并提供冲突策略与冲突回调

典型流程：定义控制器 → 加载路由 → 启动服务。

## 2. 关键类型

```typescript
import type { Context, Middleware } from 'koa'
import type { HTTPMethod } from 'find-my-way'

type HttpProps = {
  port: number
  keys?: string[]
  ignoreDuplicateSlashes?: boolean
  ignoreTrailingSlash?: boolean
  maxParamLength?: number
  allowUnsafeRegex?: boolean
  caseSensitive?: boolean
}

type ControllerFunction = (ctx: Context) => unknown | Promise<unknown>

interface ControllerRegisterProps {
  id: number
  method: HTTPMethod
  middlewares: Middleware[]
  data: Record<string, any>
}

type LoaderConflictStrategy = 'error' | 'warn' | 'override'
type LoaderConflictResolution = 'error' | 'keep' | 'override'

type LoaderConflictContext = {
  routeKey: string
  method: string
  url: string
  strategy: LoaderConflictStrategy
  resolution: LoaderConflictResolution
}

interface LoaderCompileOptions {
  defaultSuffix?: string
  prefix?: string
  conflict?: LoaderConflictStrategy
  onConflict?: (ctx: LoaderConflictContext) => void
}

type LoaderFromOptions = {
  suffix?: string
} & LoaderCompileOptions
```

## 3. 标准模板

### 3.1 创建 Http 实例

```typescript
import { Http } from '@hile/http'

const http = new Http({ port: 3000 })
```

### 3.2 注册全局中间件

```typescript
http.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  ctx.set('X-Response-Time', `${Date.now() - start}ms`)
})
```

规则：必须在 `listen()` 前调用。

### 3.3 手动注册路由

```typescript
const off = http.get('/api/users', async (ctx) => {
  ctx.body = { users: [] }
})

off()
```

规则：所有路由注册方法都返回注销函数。

### 3.4 定义控制器

无中间件：

```typescript
import { defineController } from '@hile/http'

export default defineController('GET', async (ctx) => {
  return { ok: true }
})
```

带中间件：

```typescript
import { defineController } from '@hile/http'

const auth = async (ctx, next) => {
  if (!ctx.headers.authorization) ctx.throw(401)
  await next()
}

export default defineController('POST', [auth], async (ctx) => {
  return { created: true }
})
```

规则：

- 控制器文件必须 `export default`
- 控制器函数签名为 `(ctx)`，不是 `(ctx, next)`
- 返回值非 `undefined` 时自动写入 `ctx.body`

### 3.5 文件系统自动路由

```typescript
await http.load('./src/controllers', {
  suffix: 'controller',
  defaultSuffix: '/index',
  prefix: '/api',
  conflict: 'warn',
  onConflict: (ctx) => {
    console.warn('route conflict', ctx)
  },
})
```

文件路径映射示例：

| 文件路径 | 路由路径 |
|---|---|
| `index.controller.ts` | `/api` |
| `users/index.controller.ts` | `/api/users` |
| `users/[id].controller.ts` | `/api/users/:id` |

冲突策略说明：

- `error`：同一 `method + path` 冲突时抛错（默认）
- `warn`：保留旧路由并发出警告
- `override`：新路由覆盖旧路由

`onConflict` 会在发生冲突时回调，提供 `routeKey/method/url/strategy/resolution`。

`from()` 会校验控制器默认导出类型。若导出不合法，错误信息包含文件路径和导出摘要，便于定位。

## 4. 强制规则

1. 全局中间件必须在 `listen()` 前注册。
2. 控制器必须 default 导出。
3. 控制器文件命名使用 `*.controller.ts/js`（或与 `suffix` 一致）。
4. 需要多个 HTTP 方法时，default 导出数组。
5. 控制器里不要调用 `next()`，需要 `next` 的逻辑放中间件。
6. `load()` 为异步，必须 `await`。
7. 大型项目建议显式设置 `conflict` 策略，避免隐式覆盖。

## 5. 常见反模式

### 控制器中调用 next

```typescript
// ✗
export default defineController('GET', async (ctx, next) => {
  await next()
  return { ok: true }
})

// ✓
export default defineController('GET', async (ctx) => {
  return { ok: true }
})
```

### 重复设置响应

```typescript
// ✗
export default defineController('GET', async (ctx) => {
  ctx.body = { a: 1 }
  return { b: 2 }
})

// ✓
export default defineController('GET', async () => {
  return { b: 2 }
})
```

### 不配置冲突策略导致行为不清晰

```typescript
// ✗ 不清晰：项目多人协作时难以统一预期
await http.load('./src/controllers')

// ✓ 显式策略：可读且可审计
await http.load('./src/controllers', { conflict: 'error' })
```

## 6. 与 @hile/core 集成

```typescript
import { defineService } from '@hile/core'
import { Http } from '@hile/http'

export const httpService = defineService(async (shutdown) => {
  const http = new Http({ port: 3000 })
  await http.load('./src/controllers', { suffix: 'controller', prefix: '/api' })

  const close = await http.listen()
  shutdown(close)

  return http
})
```

## 7. API 速查

| 导出 | 说明 |
|---|---|
| `Http` | HTTP 服务实例类 |
| `defineController` | 控制器定义函数 |
| `Loader` | 路由加载器 |
| `compileRoutePath` | 路径编译纯函数 |
| `toRouterPath` | 参数路径转换纯函数 |