---
name: hile-http
description: Code generation and usage rules for @hile/http HTTP service framework. Use when building routes, controllers, middleware, or when the user asks about @hile/http, defineController, Loader, or Koa-based HTTP patterns.
---

# @hile/http

`@hile/http` 是基于 Koa + find-my-way 的 HTTP 服务框架。本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的 HTTP 服务代码。

---

## 1. 架构总览

`@hile/http` 提供三层抽象：

- **Http 类** — 服务核心，封装 Koa 实例和路由器，提供中间件注册、路由注册和服务启停
- **defineController** — 控制器定义函数，将 HTTP 方法 + 中间件 + 处理函数打包为标准控制器对象
- **Loader** — 路由加载器，支持手动编译绑定和基于文件系统的自动路由加载

典型工作流：`定义控制器 → 通过 Loader 编译绑定到 Http → 启动服务`

### 依赖关系

```
@hile/http
├── koa              — Web 框架
├── koa-compose      — 中间件组合
├── find-my-way      — 高性能路由匹配
└── glob             — 文件系统路由扫描
```

---

## 2. 类型签名

生成代码时，必须严格遵循以下类型：

```typescript
import { Context, Middleware } from 'koa'
// HTTPMethod 来自依赖 find-my-way，本包未再导出；可用字符串字面量 'GET' 等，或从 'find-my-way' 引入类型
import { HTTPMethod } from 'find-my-way'

// Http 配置（port 必填，其余可选）
type HttpProps = {
  port: number
  keys?: string[]
  ignoreDuplicateSlashes?: boolean   // 默认 true
  ignoreTrailingSlash?: boolean      // 默认 true
  maxParamLength?: number            // 默认 +Infinity
  allowUnsafeRegex?: boolean         // 默认 true
  caseSensitive?: boolean            // 默认 true
}

// 控制器处理函数：接收 Koa Context，返回值自动赋给 ctx.body
type ControllerFunction = (ctx: Context) => unknown | Promise<unknown>

// 控制器注册信息：由 defineController 返回
interface ControllerRegisterProps {
  id: number
  method: HTTPMethod
  middlewares: Middleware[]
  data: Record<string, any>      // 编译后 data.url 会被自动设置
}

// Loader 编译选项
interface LoaderCompileOptions {
  defaultSuffix?: string    // 默认 '/index'，匹配时去除该后缀
  prefix?: string           // 路由前缀
}

// Loader 文件加载选项
type LoaderFromOptions = {
  suffix?: string           // 文件后缀标记，默认 'controller'
} & LoaderCompileOptions
```

---

## 3. 代码生成模板

### 3.1 创建 Http 服务（必须遵循的模式）

**模板：**

```typescript
import { Http } from '@hile/http'

const http = new Http({
  port: 3000,
})
```

**规则：**
- 构造参数 `port` **必填**
- 不需要手动传 `keys`，框架会自动生成随机密钥
- 路由器默认配置（忽略重复斜杠、忽略尾部斜杠、大小写敏感）通常无需修改

### 3.2 注册全局中间件

**模板：**

```typescript
http.use(async (ctx, next) => {
  const start = Date.now()
  await next()
  ctx.set('X-Response-Time', `${Date.now() - start}ms`)
})
```

**规则：**
- `use()` **必须**在 `listen()` 之前调用
- 中间件签名固定为 `(ctx: Context, next: Next) => Promise<void>`
- `use()` 返回 `this`，支持链式调用
- 全局中间件对 **所有路由** 生效

### 3.3 手动注册路由

**模板：**

```typescript
// 注册路由，返回注销函数
const off = http.get('/api/users', async (ctx) => {
  ctx.body = { users: [] }
})

// 需要时可注销路由
off()
```

**规则：**
- 使用 `http.get()` / `http.post()` / `http.put()` / `http.delete()` / `http.trace()` 快捷方法
- 或使用 `http.route(method, url, ...middlewares)` 指定任意 HTTP 方法
- 所有路由注册方法 **都返回注销回调函数**，调用后路由不再匹配
- 路由支持路径参数：`/users/:id`
- 路由支持多个中间件，按顺序执行

### 3.4 定义控制器（文件路由模式，必须遵循的模式）

**模板（简洁写法 — 无额外中间件）：**

```typescript
import { defineController } from '@hile/http'

export default defineController('GET', (ctx) => {
  return { message: 'hello' }
})
```

**模板（带中间件）：**

```typescript
import { defineController } from '@hile/http'

const authMiddleware = async (ctx, next) => {
  if (!ctx.headers.authorization) {
    ctx.throw(401)
  }
  await next()
}

export default defineController('POST', [authMiddleware], (ctx) => {
  return { data: ctx.request.body }
})
```

**规则：**
- 第一个参数 **必须** 是 HTTP 方法字符串：`'GET'` | `'POST'` | `'PUT'` | `'DELETE'` 等
- 第二个参数可以是 **控制器函数**（无中间件时）或 **中间件数组**（有中间件时）
- 有中间件数组时，第三个参数 **必须** 是控制器函数
- 控制器函数接收 `ctx: Context`，返回值非 `undefined` 时自动赋给 `ctx.body`
- 返回 `undefined` 时不修改 `ctx.body`（用于流式响应或手动设置）
- 控制器文件 **必须** `export default` 导出 `defineController` 的返回值
- 一个文件可以导出单个控制器或控制器数组（用于同一路径注册多个 HTTP 方法）

### 3.5 文件系统路由（自动加载）

**模板：**

```typescript
import { Http } from '@hile/http'

const http = new Http({ port: 3000 })
const off = await http.load('./src/controllers', {
  suffix: 'controller',       // 匹配 *.controller.{ts,js} 文件
  defaultSuffix: '/index',    // index 文件映射到父路径
  prefix: '/api',             // 所有路由添加前缀
})
```

**规则：**
- `load()` 扫描目录下所有匹配 `**/*.{suffix}.{ts,js}` 的文件
- 文件路径自动转换为路由路径（去除后缀标记和文件扩展名）
- `load()` 返回 `Promise<() => void>`，**必须** `await`
- 返回的注销函数调用后移除所有加载的路由

### 3.6 文件路由路径转换规则

文件系统路径到路由路径的转换遵循以下规则：

| 文件路径 | 路由路径 | 说明 |
|---------|---------|------|
| `users/index.controller.ts` | `/users` 或 `/` | `index` 被 defaultSuffix 去除 |
| `users/list.controller.ts` | `/users/list` | 普通路径 |
| `users/[id].controller.ts` | `/users/:id` | `[param]` 转换为 `:param` |
| `[category]/[id].controller.ts` | `/:category/:id` | 多参数 |
| `index.controller.ts` | `/` | 根路径 |

**转换流程：**
1. 去除文件名中的 `.{suffix}.{ts,js}` 后缀
2. 路径不以 `/` 开头时自动补充
3. 路径以 `defaultSuffix`（默认 `/index`）结尾时去除该后缀
4. 去除后为空则重置为 `/`
5. 添加 `prefix` 前缀（如果指定）
6. 将 `[param]` 替换为 `:param`

### 3.7 启动服务

**模板：**

```typescript
const close = await http.listen((server) => {
  console.log(`Server running on port ${http.port}`)
})

// 关闭服务
close()
```

**规则：**
- `listen()` 返回 `Promise<() => void>`，**必须** `await`
- 可选传入 `onListen` 回调，在服务端口绑定前执行，接收 `Server` 对象
- 返回的关闭函数调用后停止服务

---

## 4. 强制规则（生成代码时必须遵守）

| # | 规则 | 原因 |
|---|------|------|
| 1 | 全局中间件 **必须** 在 `listen()` 之前通过 `use()` 注册 | `listen()` 内部冻结中间件栈 |
| 2 | 控制器文件 **必须** `export default` 导出 | Loader 通过 `import(path).default` 加载 |
| 3 | 控制器文件命名 **必须** 以 `{suffix}.ts` 结尾 | 默认为 `*.controller.ts`，Loader 通过文件名后缀匹配 |
| 4 | `defineController` 的控制器函数参数是 `ctx`（不是 `ctx, next`） | 框架自动包装为中间件，`ctx.body` 由返回值自动设置 |
| 5 | 控制器函数需要返回响应数据时 **直接 return** | 不要手动 `ctx.body = ...` 然后又 return 值 |
| 6 | 路由参数使用 `[param]` 方括号语法 | Loader 会自动转换为 find-my-way 的 `:param` 格式 |
| 7 | `load()` 返回 Promise，**必须** `await` | 内部有异步文件扫描和动态 import |
| 8 | 同一路径的多个 HTTP 方法控制器 **导出为数组** | `export default [getController, postController]` |
| 9 | **不要** 在控制器函数中调用 `next()` | 控制器是终端处理器，不是中间件 |
| 10 | 需要 `next()` 的逻辑 **放在中间件数组中** | `defineController('GET', [myMiddleware], handler)` |

---

## 5. 完整示例：项目结构

```
src/
├── controllers/
│   ├── index.controller.ts             # GET /api
│   ├── users/
│   │   ├── index.controller.ts         # GET /api/users
│   │   └── [id].controller.ts          # GET /api/users/:id, PUT /api/users/:id
│   └── posts/
│       ├── index.controller.ts         # GET /api/posts, POST /api/posts
│       └── [id].controller.ts          # GET /api/posts/:id
├── middlewares/
│   ├── logger.ts
│   └── auth.ts
└── main.ts
```

### middlewares/logger.ts

```typescript
import { Middleware } from 'koa'

export const logger: Middleware = async (ctx, next) => {
  const start = Date.now()
  await next()
  const ms = Date.now() - start
  console.log(`${ctx.method} ${ctx.url} - ${ctx.status} ${ms}ms`)
}
```

### middlewares/auth.ts

```typescript
import { Middleware } from 'koa'

export const auth: Middleware = async (ctx, next) => {
  const token = ctx.headers.authorization
  if (!token) {
    ctx.throw(401, 'Unauthorized')
  }
  await next()
}
```

### controllers/index.controller.ts

```typescript
import { defineController } from '@hile/http'

export default defineController('GET', () => {
  return { status: 'ok', timestamp: Date.now() }
})
```

### controllers/users/index.controller.ts

```typescript
import { defineController } from '@hile/http'

export default defineController('GET', async (ctx) => {
  return { users: [] }
})
```

### controllers/users/[id].controller.ts

```typescript
import { defineController } from '@hile/http'
import { auth } from '../../middlewares/auth'

const getUser = defineController('GET', async (ctx) => {
  const { id } = ctx.params
  return { id, name: `User ${id}` }
})

const updateUser = defineController('PUT', [auth], async (ctx) => {
  const { id } = ctx.params
  return { id, updated: true }
})

export default [getUser, updateUser]
```

### controllers/posts/index.controller.ts

```typescript
import { defineController } from '@hile/http'
import { auth } from '../../middlewares/auth'

const getPosts = defineController('GET', async (ctx) => {
  return { posts: [] }
})

const createPost = defineController('POST', [auth], async (ctx) => {
  return { created: true }
})

export default [getPosts, createPost]
```

### controllers/posts/[id].controller.ts

```typescript
import { defineController } from '@hile/http'

export default defineController('GET', async (ctx) => {
  const { id } = ctx.params
  return { id, title: `Post ${id}` }
})
```

### main.ts

```typescript
import { Http } from '@hile/http'
import { logger } from './middlewares/logger'

async function main() {
  const http = new Http({ port: 3000 })

  http.use(logger)

  await http.load('./src/controllers', {
    suffix: 'controller',
    prefix: '/api',
  })

  const close = await http.listen(() => {
    console.log(`Server running on http://localhost:${http.port}`)
  })
}

main()
```

### 生成的路由表

| 方法 | 路径 | 来源文件 |
|------|------|---------|
| GET | `/api` | `index.controller.ts` |
| GET | `/api/users` | `users/index.controller.ts` |
| GET | `/api/users/:id` | `users/[id].controller.ts` |
| PUT | `/api/users/:id` | `users/[id].controller.ts` |
| GET | `/api/posts` | `posts/index.controller.ts` |
| POST | `/api/posts` | `posts/index.controller.ts` |
| GET | `/api/posts/:id` | `posts/[id].controller.ts` |

---

## 6. 反模式（生成代码时必须避免）

### 6.1 不要在控制器函数中调用 next()

```typescript
// ✗ 错误：控制器函数不是中间件，不应调用 next
export default defineController('GET', async (ctx, next) => {
  await next()
  return { data: 'hello' }
})

// ✓ 正确：直接返回数据
export default defineController('GET', async (ctx) => {
  return { data: 'hello' }
})
```

### 6.2 不要同时 return 和手动设置 ctx.body

```typescript
// ✗ 错误：重复设置，return 值会覆盖
export default defineController('GET', async (ctx) => {
  ctx.body = { wrong: true }
  return { right: true }
})

// ✓ 正确：只用 return
export default defineController('GET', async (ctx) => {
  return { right: true }
})

// ✓ 也正确：只用 ctx.body，return undefined
export default defineController('GET', async (ctx) => {
  ctx.body = fs.createReadStream('file.txt')
})
```

### 6.3 不要在 listen() 之后注册全局中间件

```typescript
// ✗ 错误：listen 后注册的中间件不会生效
const close = await http.listen()
http.use(lateMiddleware)

// ✓ 正确：在 listen 之前注册
http.use(earlyMiddleware)
const close = await http.listen()
```

### 6.4 不要忘记 export default

```typescript
// ✗ 错误：Loader 无法加载，因为没有 default 导出
export const myController = defineController('GET', () => 'hello')

// ✓ 正确
export default defineController('GET', () => 'hello')
```

### 6.5 不要手动写路径参数为 :param 格式

```typescript
// ✗ 错误：文件名使用 :param（文件系统不支持冒号）
// 文件名: users/:id.controller.ts

// ✓ 正确：文件名使用 [param]
// 文件名: users/[id].controller.ts
```

### 6.6 不要把 load() 的 await 遗漏

```typescript
// ✗ 错误：load 是异步的，不 await 会导致路由未注册就启动服务
http.load('./controllers')
const close = await http.listen()

// ✓ 正确
await http.load('./controllers')
const close = await http.listen()
```

---

## 7. API 速查

### Http 类

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `(props: HttpProps)` | 创建 Http 服务实例 |
| `port` | `number` (getter) | 获取端口号 |
| `use` | `(middleware: Middleware) => this` | 注册全局中间件，支持链式调用 |
| `listen` | `(onListen?) => Promise<() => void>` | 启动服务，返回关闭函数 |
| `get` | `(url, ...middlewares) => () => void` | 注册 GET 路由，返回注销函数 |
| `post` | `(url, ...middlewares) => () => void` | 注册 POST 路由，返回注销函数 |
| `put` | `(url, ...middlewares) => () => void` | 注册 PUT 路由，返回注销函数 |
| `delete` | `(url, ...middlewares) => () => void` | 注册 DELETE 路由，返回注销函数 |
| `trace` | `(url, ...middlewares) => () => void` | 注册 TRACE 路由，返回注销函数 |
| `route` | `(method, url, ...middlewares) => () => void` | 注册任意方法路由，返回注销函数 |
| `load` | `(directory, options?) => Promise<() => void>` | 文件系统路由加载，返回注销函数 |

### defineController 函数

| 调用形式 | 说明 |
|---------|------|
| `defineController(method, fn: ControllerFunction)` | 无中间件，直接传控制器函数 |
| `defineController(method, middlewares: Middleware[], fn: ControllerFunction)` | 有中间件数组 + 控制器函数 |

**返回值 `ControllerRegisterProps`（非泛型）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | `number` | 唯一 ID |
| `method` | `HTTPMethod` | HTTP 方法 |
| `middlewares` | `Middleware[]` | 中间件数组（含控制器包装后的尾部中间件） |
| `data` | `Record<string, any>` | 编译后 `data.url` 为实际路由路径 |

### Loader 类

| 方法 | 签名 | 说明 |
|------|------|------|
| `compile` | `(path, controllers: ControllerRegisterProps \| ControllerRegisterProps[], options?) => () => void` | 手动编译绑定路由 |
| `from` | `(directory, options?) => Promise<() => void>` | 文件系统批量加载 |

---

## 8. 内部机制（供理解，不供直接调用）

### Http 内部组成

| 组件 | 类型 | 说明 |
|------|------|------|
| `koa` | `Koa` | Koa 实例，处理中间件管线 |
| `router` | `Instance` | find-my-way 包装实例，高性能路由匹配 |
| `loader` | `Loader` | 路由加载器实例 |
| `server` | `Server?` | Node.js HTTP Server，listen 后创建 |

### 路由匹配流程

```
HTTP 请求到达
  │
  ├─ Koa 中间件管线（use 注册的全局中间件按顺序执行）
  │
  └─ router.routes()（最后一个中间件）
       │
       ├─ find-my-way.find(method, path)
       │   ├─ 匹配成功 → 设置 ctx.params, ctx.store → 执行路由中间件
       │   └─ 匹配失败 → defaultRoute → 调用 next()（返回 404）
       │
       └─ 路由中间件（koa-compose 组合）
            ├─ 用户定义的中间件（defineController 的 middlewares 参数）
            └─ 控制器包装中间件（执行 fn(ctx)，返回值赋给 ctx.body）
```

### Loader 文件路径转换流程

```
文件: users/[id].controller.ts
  │
  ├─ 去除后缀 → users/[id].
  ├─ 去除扩展名和点 → users/[id]
  ├─ 补充前导斜杠 → /users/[id]
  ├─ 检查 defaultSuffix → 不匹配，保持
  ├─ 添加 prefix → /api/users/[id]
  └─ 替换参数 → /api/users/:id
```

### 控制器包装机制

`defineController` 将控制器函数包装为 Koa 中间件并追加到 `middlewares` 末尾：

```
defineController('GET', [mw1, mw2], fn)
  → middlewares = [mw1, mw2, async (ctx) => {
      const result = await fn(ctx)
      if (result !== undefined) ctx.body = result
    }]
```

控制器函数 `fn` 的返回值类型为 `unknown | Promise<unknown>`：
- 返回非 `undefined` 值 → 自动设置 `ctx.body`
- 返回 `undefined` → 不修改 `ctx.body`（用于流、手动设置等场景）

---

## 9. 与 hile（core）集成

`@hile/http` 通常通过 `hile` 服务容器进行管理：

```typescript
import { defineService, loadService } from '@hile/core'
import { Http } from '@hile/http'

export const httpService = defineService(async (shutdown) => {
  const http = new Http({ port: 3000 })

  http.use(logger)
  await http.load('./src/controllers', { suffix: 'controller', prefix: '/api' })

  const close = await http.listen(() => {
    console.log(`Server running on port ${http.port}`)
  })

  shutdown(close)

  return http
})
```

**规则：**
- 将 `listen()` 返回的 `close` 函数注册为 `shutdown` 回调
- 通过 `loadService(httpService)` 在其他地方获取 Http 实例

---

## 10. 开发

```bash
pnpm --filter @hile/http install
pnpm --filter @hile/http build
pnpm --filter @hile/http test
pnpm --filter @hile/http dev
```

**技术栈：** TypeScript, Koa, find-my-way, Vitest

## License

MIT
