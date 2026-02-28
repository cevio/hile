# @hile/http

基于 Koa + find-my-way 的 HTTP 服务框架，支持中间件、路由注册和文件系统自动路由加载。

## 安装

```bash
pnpm add @hile/http
```

## 快速开始

```typescript
import { Http } from '@hile/http'

const http = new Http({ port: 3000 })

http.get('/hello', async (ctx) => {
  ctx.body = 'Hello, World!'
})

const close = await http.listen(() => {
  console.log('Server running on http://localhost:3000')
})
```

## 核心概念

### 创建服务

```typescript
const http = new Http({
  port: 3000,
  keys: ['secret1', 'secret2'],  // 可选，不传则自动生成
})
```

### 中间件

通过 `use()` 注册全局中间件，支持链式调用。中间件必须在 `listen()` 之前注册。

```typescript
http
  .use(async (ctx, next) => {
    const start = Date.now()
    await next()
    ctx.set('X-Response-Time', `${Date.now() - start}ms`)
  })
  .use(async (ctx, next) => {
    console.log(`${ctx.method} ${ctx.url}`)
    await next()
  })
```

### 路由

使用快捷方法注册路由，支持路径参数和多个中间件：

```typescript
http.get('/users', async (ctx) => {
  ctx.body = [{ id: 1, name: 'Alice' }]
})

http.get('/users/:id', async (ctx) => {
  ctx.body = { id: ctx.params.id }
})

http.post('/users', authMiddleware, async (ctx) => {
  ctx.body = { created: true }
})
```

所有路由方法返回注销函数，调用后路由不再匹配：

```typescript
const off = http.get('/temporary', async (ctx) => {
  ctx.body = 'gone soon'
})

off() // 移除该路由
```

支持的快捷方法：`get`、`post`、`put`、`delete`、`trace`，或使用 `route()` 指定任意 HTTP 方法：

```typescript
http.route('PATCH', '/users/:id', async (ctx) => {
  ctx.body = { patched: true }
})
```

### 启动与关闭

```typescript
const close = await http.listen((server) => {
  console.log(`Listening on port ${http.port}`)
})

// 关闭服务
close()
```

## 文件系统路由

### 定义控制器

使用 `defineController` 定义路由控制器。返回值自动赋给 `ctx.body`。

```typescript
// controllers/users/index.controller.ts
import { defineController } from '@hile/http'

export default defineController('GET', async (ctx) => {
  return { users: [] }
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

同一文件导出多个控制器：

```typescript
// controllers/users/[id].controller.ts
import { defineController } from '@hile/http'

const getUser = defineController('GET', async (ctx) => {
  return { id: ctx.params.id }
})

const updateUser = defineController('PUT', [auth], async (ctx) => {
  return { updated: true }
})

export default [getUser, updateUser]
```

### 加载路由

使用 `load()` 自动扫描目录并注册路由：

```typescript
await http.load('./src/controllers', {
  suffix: 'controller',    // 匹配 *.controller.{ts,js}
  prefix: '/api',          // 路由前缀
  defaultSuffix: '/index', // index 文件映射到父路径
})
```

### 路径映射规则

| 文件路径 | 路由路径 |
|---------|---------|
| `index.controller.ts` | `/api` |
| `users/index.controller.ts` | `/api/users` |
| `users/list.controller.ts` | `/api/users/list` |
| `users/[id].controller.ts` | `/api/users/:id` |
| `[category]/[id].controller.ts` | `/api/:category/:id` |

路径中的 `[param]` 会自动转换为 `:param` 路由参数。

## 与 hile 集成

配合 `hile` 服务容器管理 HTTP 服务的生命周期：

```typescript
import { defineService } from '@hile/core'
import { Http } from '@hile/http'

export const httpService = defineService(async (shutdown) => {
  const http = new Http({ port: 3000 })

  await http.load('./src/controllers', {
    suffix: 'controller',
    prefix: '/api',
  })

  const close = await http.listen()
  shutdown(close)

  return http
})
```

## API

本包导出：`Http`、`defineController`、`Loader`，以及类型 `HttpProps`、`LoaderCompileOptions`、`LoaderFromOptions`、`ControllerRegisterProps`、`ControllerFunction`。

### Http

| 方法 | 说明 |
|------|------|
| `new Http(props)` | 创建实例，`port` 必填 |
| `port` | 获取端口号 |
| `use(middleware)` | 注册全局中间件，返回 `this` |
| `listen(onListen?)` | 启动服务，返回关闭函数 |
| `get(url, ...mw)` | 注册 GET 路由，返回注销函数 |
| `post(url, ...mw)` | 注册 POST 路由，返回注销函数 |
| `put(url, ...mw)` | 注册 PUT 路由，返回注销函数 |
| `delete(url, ...mw)` | 注册 DELETE 路由，返回注销函数 |
| `trace(url, ...mw)` | 注册 TRACE 路由，返回注销函数 |
| `route(method, url, ...mw)` | 注册任意方法路由，返回注销函数 |
| `load(dir, options?)` | 加载文件系统路由，返回注销函数 |

### defineController

| 调用形式 | 说明 |
|---------|------|
| `defineController(method, fn)` | 无中间件 |
| `defineController(method, [mw...], fn)` | 带中间件 |

- 控制器函数接收 `ctx`，返回值非 `undefined` 时自动设为 `ctx.body`
- 控制器文件必须 `export default` 导出

### load 选项

| 选项 | 默认值 | 说明 |
|------|-------|------|
| `suffix` | `'controller'` | 文件后缀标记 |
| `prefix` | — | 路由前缀 |
| `defaultSuffix` | `'/index'` | 映射到父路径的文件名 |

## License

MIT
