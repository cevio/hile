# @hile/http

基于 Koa + find-my-way 的 HTTP 服务框架，支持中间件、路由注册与文件系统自动路由加载。

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

## 核心能力

### 创建服务

```typescript
const http = new Http({
  port: 3000,
  keys: ['secret1', 'secret2'],
})
```

### 全局中间件

> 中间件请在 `listen()` 之前注册。

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

### 手动路由

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

所有路由注册函数都返回注销函数：

```typescript
const off = http.get('/temporary', async (ctx) => {
  ctx.body = 'gone soon'
})

off()
```

快捷方法：`get`、`post`、`put`、`delete`、`trace`。也可使用 `route()`：

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

close()
```

## 文件系统路由

### 定义控制器

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

同文件多控制器：

```typescript
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

```typescript
await http.load('./src/controllers', {
  suffix: 'controller',
  prefix: '/api',
  defaultSuffix: '/index',
})
```

### 路径映射

| 文件路径 | 路由路径 |
|---------|---------|
| `index.controller.ts` | `/api` |
| `users/index.controller.ts` | `/api/users` |
| `users/list.controller.ts` | `/api/users/list` |
| `users/[id].controller.ts` | `/api/users/:id` |
| `[category]/[id].controller.ts` | `/api/:category/:id` |

`[param]` 会自动转换为 `:param`。

## 与 @hile/core 集成

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

导出：`Http`、`defineController`、`Loader` 以及类型 `HttpProps`、`LoaderCompileOptions`、`LoaderFromOptions`、`ControllerRegisterProps`、`ControllerFunction`。

### `Http`

| 方法 | 说明 |
|------|------|
| `new Http(props)` | 创建实例，`port` 必填 |
| `port` | 获取端口号 |
| `use(middleware)` | 注册全局中间件 |
| `listen(onListen?)` | 启动服务，返回关闭函数 |
| `get/post/put/delete/trace(url, ...mw)` | 注册路由，返回注销函数 |
| `route(method, url, ...mw)` | 注册任意方法路由 |
| `load(dir, options?)` | 加载文件系统路由 |

### `defineController`

| 调用形式 | 说明 |
|---------|------|
| `defineController(method, fn)` | 无中间件 |
| `defineController(method, [mw...], fn)` | 带中间件 |

- 控制器返回值非 `undefined` 时自动赋值给 `ctx.body`
- 控制器文件必须 `export default`

### `load` 选项

| 选项 | 默认值 | 说明 |
|------|-------|------|
| `suffix` | `'controller'` | 文件后缀标记 |
| `prefix` | — | 路由前缀 |
| `defaultSuffix` | `'/index'` | 映射到父路径的文件名 |
| `conflict` | `'error'` | 路由冲突策略：`error` 抛错、`warn` 保留旧路由、`override` 覆盖旧路由 |
| `onConflict` | — | 冲突回调，接收 `{ routeKey, method, url, strategy, resolution }` |

`from()` 会校验控制器文件的默认导出是否为 `ControllerRegisterProps` 或其数组。若不合法，错误信息会包含文件路径与导出摘要，便于快速定位。

## License

MIT
