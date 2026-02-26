# Hile

轻量级异步服务容器，提供单例管理、并发请求合并和资源生命周期销毁。纯 TypeScript 实现，零运行时依赖。

## 安装

```bash
pnpm add hile
```

## 快速开始

```typescript
import { defineService, loadService } from 'hile'

// 定义服务
const greeterService = defineService(async (shutdown) => {
  return {
    hello(name: string) {
      return `Hello, ${name}!`
    }
  }
})

// 加载并使用
const greeter = await loadService(greeterService)
greeter.hello('World') // "Hello, World!"
```

## 核心概念

### 定义服务

使用 `defineService` 注册一个服务。服务函数接收一个 `shutdown` 参数，用于注册资源清理回调。

```typescript
import { defineService } from 'hile'

export const databaseService = defineService(async (shutdown) => {
  const pool = await createPool('postgres://localhost:5432/app')
  shutdown(() => pool.end())
  return pool
})
```

### 加载服务

使用 `loadService` 获取服务实例。容器保证服务函数只执行一次，后续调用直接返回缓存结果。

```typescript
import { loadService } from 'hile'
import { databaseService } from './services/database'

const db = await loadService(databaseService)
const users = await db.query('SELECT * FROM users')
```

### 并发请求合并

多个地方同时请求同一服务时，服务函数不会重复执行，所有调用者共享同一结果。

```typescript
// 三个并发调用，服务函数只执行一次
const [r1, r2, r3] = await Promise.all([
  loadService(heavyService),
  loadService(heavyService),
  loadService(heavyService),
])
// r1 === r2 === r3
```

### 服务间依赖

在服务函数内部通过 `loadService` 加载所依赖的其他服务：

```typescript
import { defineService, loadService } from 'hile'
import { databaseService } from './database'
import { cacheService } from './cache'

export const userService = defineService(async (shutdown) => {
  const db = await loadService(databaseService)
  const cache = await loadService(cacheService)

  return {
    async getById(id: number) {
      const cached = await cache.get(`user:${id}`)
      if (cached) return JSON.parse(cached)
      const user = await db.query('SELECT * FROM users WHERE id = $1', [id])
      await cache.set(`user:${id}`, JSON.stringify(user))
      return user
    }
  }
})
```

### 资源销毁（Shutdown）

服务函数的第一个参数 `shutdown` 是一个注册器，用于在初始化过程中注册清理回调。当服务启动失败时，容器会自动执行已注册的清理回调。

```typescript
export const connectionService = defineService(async (shutdown) => {
  const primary = await connectPrimary()
  shutdown(() => primary.disconnect())    // 最后执行

  const replica = await connectReplica()
  shutdown(() => replica.disconnect())    // 第 2 个执行

  const cache = await initCache()
  shutdown(() => cache.flush())           // 最先执行

  return { primary, replica, cache }
})
```

**关键特性：**

- 销毁回调按 **逆序（LIFO）** 执行——后注册的先执行
- 支持异步清理函数
- 同一函数引用多次注册只会执行一次
- 清理函数自身的错误不会影响原始错误的传播

> **注意：** 请使用 `async` 函数定义服务。同步函数中直接 `throw` 的错误无法触发销毁机制。

## 隔离容器

除默认容器外，可以创建独立的 `Container` 实例，实现服务作用域隔离：

```typescript
import { Container } from 'hile'

const container = new Container()

const service = container.register(async (shutdown) => {
  return { value: 42 }
})

const result = await container.resolve(service)
```

## API

### 便捷函数

| 函数 | 说明 |
|------|------|
| `defineService(fn)` | 注册服务到默认容器，返回 `ServiceRegisterProps` |
| `loadService(props)` | 从默认容器加载服务，返回 `Promise<R>` |

### Container

| 方法 | 说明 |
|------|------|
| `register(fn)` | 注册服务。同一函数引用只注册一次，返回 `ServiceRegisterProps` |
| `resolve(props)` | 加载服务。根据当前状态决定执行、等待或返回缓存 |
| `hasService(fn)` | 检查服务函数是否已注册 |
| `hasMeta(id)` | 检查服务是否已运行（存在运行时元数据） |
| `getIdByService(fn)` | 根据函数引用获取服务 ID |
| `getMetaById(id)` | 根据服务 ID 获取运行时元数据 |

### 服务状态

| 状态 | 值 | `resolve` 的行为 |
|------|---|-----------------|
| 从未运行 | — | 执行服务函数 |
| 运行中 | `0` | 加入等待队列 |
| 已成功 | `1` | 返回缓存值 |
| 已失败 | `-1` | 返回缓存错误 |

## 开发

```bash
pnpm install
pnpm build        # 编译
pnpm dev          # 监听模式
pnpm test         # 运行测试
```

## License

MIT
