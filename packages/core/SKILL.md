# Hile

Hile 是一个轻量级异步服务容器。本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

Hile 的核心是 `Container`（服务容器）。所有服务都必须经过 **定义 → 加载** 两个步骤才能使用。容器保证：

- 每个服务函数只执行一次（**单例**）
- 并发请求同一服务时自动合并（**不重复执行**）
- 服务启动失败时自动执行已注册的清理回调（**销毁机制**）

模块默认导出了一个全局容器实例，并提供 `defineService` / `loadService` 两个便捷函数。

---

## 2. 类型签名

生成代码时，必须严格遵循以下类型：

```typescript
// 销毁回调：无参数，可返回 Promise
type ServiceCutDownFunction = () => unknown | Promise<unknown>;

// 销毁注册器：在服务函数内部调用，将清理回调注册到容器
type ServiceCutDownHandler = (fn: ServiceCutDownFunction) => void;

// 服务函数：第一个参数固定为销毁注册器，返回值为同步值或 Promise
type ServiceFunction<R> = (shutdown: ServiceCutDownHandler) => R | Promise<R>;

// 服务注册信息：由 defineService/register 返回，作为 loadService/resolve 的入参
interface ServiceRegisterProps<R> {
  id: number;
  fn: ServiceFunction<R>;
}
```

---

## 3. 代码生成模板

### 3.1 定义服务（必须遵循的模式）

**模板：**

```typescript
import { defineService } from '@hile/core'

export const xxxService = defineService(async (shutdown) => {
  // 1. 初始化资源
  const resource = await createResource()

  // 2. 注册销毁回调（每创建一个资源就注册一个对应的清理）
  shutdown(() => resource.close())

  // 3. 返回服务实例
  return resource
})
```

**规则：**
- 服务函数的第一个参数 **必须** 命名为 `shutdown`，类型为 `ServiceCutDownHandler`
- 服务函数 **应当** 使用 `async` 声明（确保销毁机制在失败时正确触发）
- `defineService` 的返回值 **必须** 赋值给一个模块级常量并 `export`
- 常量命名 **必须** 以 `Service` 结尾（如 `databaseService`、`cacheService`）
- 每个服务定义 **应当** 放在独立的文件中

### 3.2 加载服务

**模板：**

```typescript
import { loadService } from '@hile/core'
import { databaseService } from './services/database'

const db = await loadService(databaseService)
```

**规则：**
- **永远** 使用 `loadService()` 获取服务实例，**不要** 直接调用服务函数
- `loadService` 返回 `Promise`，**必须** `await`
- 可以在任何地方多次调用 `loadService(同一个服务)`，容器保证只执行一次

### 3.3 服务间依赖

当一个服务依赖另一个服务时，在服务函数内部通过 `loadService` 加载依赖：

```typescript
import { defineService, loadService } from '@hile/core'
import { databaseService } from './database'
import { configService } from './config'

export const userService = defineService(async (shutdown) => {
  // 加载依赖的服务（若已完成则直接返回缓存，否则等待）
  const config = await loadService(configService)
  const db = await loadService(databaseService)

  const repo = new UserRepository(db, config)
  shutdown(() => repo.dispose())

  return repo
})
```

**规则：**
- 依赖的服务通过 `import` 引入其 `ServiceRegisterProps`，然后在函数体内 `loadService` 加载
- **不要** 将 `loadService` 的结果缓存到模块作用域变量中
- **不要** 在服务函数外部调用 `loadService` 来获取另一个服务并传入——应在服务函数内部加载

### 3.4 注册销毁回调

**模板：**

```typescript
export const connectionService = defineService(async (shutdown) => {
  const primary = await connectPrimary()
  shutdown(() => primary.disconnect())    // 注册第 1 个 → 最后执行

  const replica = await connectReplica()
  shutdown(() => replica.disconnect())    // 注册第 2 个

  const cache = await initCache()
  shutdown(() => cache.flush())           // 注册第 3 个 → 最先执行

  return { primary, replica, cache }
})
```

**规则：**
- 每初始化一个需要清理的资源后，**立即** 调用 `shutdown()` 注册对应的清理函数
- 不要把所有清理逻辑放在一个 shutdown 里，**每个资源对应一个 shutdown 调用**
- 销毁函数按 **逆序（LIFO）** 执行：后注册的先执行，先注册的后执行
- 销毁函数可以是 `async`，容器会依次 `await`
- 同一个函数引用多次传给 `shutdown()` 只会注册一次

---

## 4. 强制规则（生成代码时必须遵守）

| # | 规则 | 原因 |
|---|------|------|
| 1 | 服务函数**必须**使用 `async` 声明 | 同步 `throw` 不会触发销毁机制，只有异步 reject 才会触发 |
| 2 | 服务函数第一个参数**必须**是 `shutdown` | 这是容器注入的销毁注册器，即使不使用也要声明 |
| 3 | `defineService` 的结果**必须**赋给模块级 `export const` | 服务基于函数引用去重，引用必须稳定 |
| 4 | **不要**在 `defineService` 内直接写匿名函数再传给另一个函数 | 每次调用会创建新引用，导致重复注册 |
| 5 | **不要**手动构造 `ServiceRegisterProps` 对象 | 必须通过 `defineService` 或 `container.register` 获取 |
| 6 | **不要**缓存 `loadService` 的结果到模块顶层变量 | 服务可能尚未初始化，应在需要时 `await loadService()` |
| 7 | 每个外部资源初始化后**立即**注册 `shutdown` | 确保初始化中途失败时已创建的资源能被正确清理 |
| 8 | 一个文件只定义一个服务 | 保持服务职责单一、依赖清晰 |

---

## 5. 完整示例：项目结构

```
src/
├── services/
│   ├── config.ts        # 配置服务
│   ├── database.ts      # 数据库服务（依赖 config）
│   ├── cache.ts         # 缓存服务（依赖 config）
│   └── user.ts          # 用户服务（依赖 database, cache）
└── main.ts              # 入口
```

### services/config.ts

```typescript
import { defineService } from '@hile/core'

interface AppConfig {
  dbUrl: string
  cacheHost: string
}

export const configService = defineService(async (shutdown) => {
  const config: AppConfig = {
    dbUrl: process.env.DB_URL ?? 'postgres://localhost:5432/app',
    cacheHost: process.env.CACHE_HOST ?? 'localhost',
  }
  return config
})
```

### services/database.ts

```typescript
import { defineService, loadService } from '@hile/core'
import { configService } from './config'

export const databaseService = defineService(async (shutdown) => {
  const config = await loadService(configService)
  const pool = await createPool(config.dbUrl)
  shutdown(() => pool.end())
  return pool
})
```

### services/cache.ts

```typescript
import { defineService, loadService } from '@hile/core'
import { configService } from './config'

export const cacheService = defineService(async (shutdown) => {
  const config = await loadService(configService)
  const client = await createRedisClient(config.cacheHost)
  shutdown(() => client.quit())
  return client
})
```

### services/user.ts

```typescript
import { defineService, loadService } from '@hile/core'
import { databaseService } from './database'
import { cacheService } from './cache'

interface User {
  id: number
  name: string
}

export const userService = defineService(async (shutdown) => {
  const db = await loadService(databaseService)
  const cache = await loadService(cacheService)

  return {
    async getById(id: number): Promise<User> {
      const cached = await cache.get(`user:${id}`)
      if (cached) return JSON.parse(cached)
      const user = await db.query('SELECT * FROM users WHERE id = $1', [id])
      await cache.set(`user:${id}`, JSON.stringify(user))
      return user
    }
  }
})
```

### main.ts

```typescript
import { loadService } from '@hile/core'
import { userService } from './services/user'

async function main() {
  const users = await loadService(userService)
  const user = await users.getById(1)
  console.log(user)
}

main()
```

---

## 6. 反模式（生成代码时必须避免）

### 6.1 不要使用同步 throw

```typescript
// ✗ 错误：同步 throw 不会触发 shutdown 销毁机制
export const badService = defineService((shutdown) => {
  const res = createResourceSync()
  shutdown(() => res.close())
  if (!res.isValid()) throw new Error('invalid')
  return res
})

// ✓ 正确：使用 async 函数
export const goodService = defineService(async (shutdown) => {
  const res = await createResource()
  shutdown(() => res.close())
  if (!res.isValid()) throw new Error('invalid')
  return res
})
```

### 6.2 不要在模块顶层缓存服务结果

```typescript
// ✗ 错误：模块加载时服务可能尚未就绪
const db = await loadService(databaseService)
export function query(sql: string) {
  return db.query(sql)
}

// ✓ 正确：每次在函数内部加载
export async function query(sql: string) {
  const db = await loadService(databaseService)
  return db.query(sql)
}
```

### 6.3 不要内联定义服务函数

```typescript
// ✗ 错误：每次调用 getService() 都创建新函数引用，无法去重
function getService() {
  return defineService(async (shutdown) => { ... })
}

// ✓ 正确：模块级常量
export const myService = defineService(async (shutdown) => { ... })
```

### 6.4 不要延迟注册 shutdown

```typescript
// ✗ 错误：如果 doSomething 抛错，resourceA 不会被清理
export const badService = defineService(async (shutdown) => {
  const a = await createResourceA()
  const b = await doSomething(a)
  shutdown(() => a.close())  // 太晚了！
  shutdown(() => b.close())
  return b
})

// ✓ 正确：创建后立即注册
export const goodService = defineService(async (shutdown) => {
  const a = await createResourceA()
  shutdown(() => a.close())  // 立即注册
  const b = await doSomething(a)
  shutdown(() => b.close())
  return b
})
```

---

## 7. API 速查

### 便捷函数（操作默认容器）

| 函数 | 签名 | 说明 |
|------|------|------|
| `defineService` | `<R>(fn: ServiceFunction<R>) => ServiceRegisterProps<R>` | 注册服务，返回注册信息 |
| `loadService` | `<R>(props: ServiceRegisterProps<R>) => Promise<R>` | 加载服务，返回服务实例 |

### Container 类（用于创建隔离容器）

| 方法 | 签名 | 说明 |
|------|------|------|
| `register` | `<R>(fn: ServiceFunction<R>) => ServiceRegisterProps<R>` | 注册服务。同一函数引用只注册一次 |
| `resolve` | `<R>(props: ServiceRegisterProps<R>) => Promise<R>` | 解析服务（状态机见下方） |
| `hasService` | `<R>(fn: ServiceFunction<R>) => boolean` | 检查服务是否已注册 |
| `hasMeta` | `(id: number) => boolean` | 检查服务是否已运行过 |
| `getIdByService` | `<R>(fn: ServiceFunction<R>) => number \| undefined` | 根据函数引用查 ID |
| `getMetaById` | `(id: number) => Paddings \| undefined` | 根据 ID 查运行时元数据 |

### resolve 状态机

```
resolve(props)
  │
  ├─ paddings 中无记录 → 首次运行
  │    → run(id, fn, callback)
  │    → 创建 Paddings { status: 0 }
  │    ├─ fn 成功 → status = 1, value = 返回值, 通知 queue 所有等待者
  │    └─ fn 失败 → status = -1, error = 错误
  │                → 先逆序执行 shutdown 回调
  │                → 再通知 queue 所有等待者
  │
  ├─ status = 0 (运行中) → 加入 queue 等待
  ├─ status = 1 (已成功) → 直接 resolve(缓存值)
  └─ status = -1 (已失败) → 直接 reject(缓存错误)
```

---

## 8. 内部机制（供理解，不供直接调用）

### 数据结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `packages` | `Map<Function, number>` | 函数引用 → 服务 ID |
| `paddings` | `Map<number, Paddings>` | 服务 ID → 运行时状态 |
| `shutdownFunctions` | `Map<number, ServiceCutDownFunction[]>` | 服务 ID → 销毁回调数组 |
| `shutdownQueues` | `number[]` | 注册了销毁回调的服务 ID 队列（有序） |

### Paddings 结构

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `-1 \| 0 \| 1` | -1 失败 / 0 运行中 / 1 成功 |
| `value` | `R` | 成功时的返回值 |
| `error` | `any` | 失败时的错误 |
| `queue` | `Set<{ resolve, reject }>` | 等待中的 Promise 回调 |

### 销毁执行顺序

- **单个服务内**：销毁回调按注册的逆序（LIFO）依次 `await` 执行
- **全局销毁**：按服务注册顺序的逆序依次销毁
- **触发时机**：仅在服务函数异步失败（reject）时自动触发；成功时不触发

### 函数去重机制

容器通过 `===` 比较函数引用。两个函数即使代码完全相同，只要引用不同就会被视为不同服务。因此服务必须定义为模块级常量。

---

## 9. 开发

```bash
pnpm install
pnpm build        # 编译
pnpm dev          # 监听模式
pnpm test         # 运行测试
```

**技术栈：** TypeScript, Vitest

## License

MIT
