# @hile/core

轻量级异步服务容器，提供单例管理、并发请求合并与生命周期销毁能力。纯 TypeScript 实现，零运行时依赖。

## 安装

```bash
pnpm add @hile/core
```

## 快速开始

```typescript
import { defineService, loadService } from '@hile/core'

const greeterService = defineService(async (shutdown) => {
  return {
    hello(name: string) {
      return `Hello, ${name}!`
    }
  }
})

const greeter = await loadService(greeterService)
greeter.hello('World') // Hello, World!
```

## 核心概念

### 1) 定义服务

通过 `defineService` 注册服务。服务函数接收 `shutdown` 注册器，用于登记资源清理回调。

```typescript
import { defineService } from '@hile/core'

export const databaseService = defineService(async (shutdown) => {
  const pool = await createPool('postgres://localhost:5432/app')
  shutdown(() => pool.end())
  return pool
})
```

### 2) 加载服务

通过 `loadService` 获取服务实例。容器保证同一服务函数只执行一次。

```typescript
import { loadService } from '@hile/core'
import { databaseService } from './services/database'

const db = await loadService(databaseService)
const users = await db.query('SELECT * FROM users')
```

### 3) 并发请求合并

并发加载同一服务时，初始化只执行一次，调用方共享结果。

```typescript
const [r1, r2, r3] = await Promise.all([
  loadService(heavyService),
  loadService(heavyService),
  loadService(heavyService),
])

// r1 === r2 === r3
```

### 4) 服务间依赖

服务内部可通过 `loadService` 继续加载依赖服务。

```typescript
import { defineService, loadService } from '@hile/core'
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

### 5) 资源销毁（Shutdown）

当服务初始化失败或手动执行全局关闭时，容器会按规则执行已注册的清理回调。

```typescript
export const connectionService = defineService(async (shutdown) => {
  const primary = await connectPrimary()
  shutdown(() => primary.disconnect())

  const replica = await connectReplica()
  shutdown(() => replica.disconnect())

  const cache = await initCache()
  shutdown(() => cache.flush())

  return { primary, replica, cache }
})
```

特性：

- 清理回调按逆序（LIFO）执行
- 支持异步清理函数
- 同一函数引用重复注册只执行一次
- 清理函数错误不会覆盖原始业务错误

> 建议始终使用 `async` 服务函数，确保异常路径可正确触发销毁机制。

### 6) 手动销毁（Graceful Shutdown）

```typescript
import container from '@hile/core'

process.on('SIGTERM', async () => {
  await container.shutdown()
  process.exit(0)
})
```

### 7) 服务校验（isService）

```typescript
import { defineService, isService } from '@hile/core'

const myService = defineService(async (shutdown) => 'hello')

isService(myService) // true
isService({ id: 1, fn: () => {} } as any) // false
```

## 隔离容器

除了默认容器，也可以手动创建独立容器以实现作用域隔离。

```typescript
import { Container } from '@hile/core'

const container = new Container()

const service = container.register(async (shutdown) => {
  return { value: 42 }
})

const result = await container.resolve(service)
```

## API

### 顶层函数

| 函数 | 说明 |
|------|------|
| `defineService(fn)` | 注册服务到默认容器 |
| `loadService(props)` | 从默认容器加载服务 |
| `isService(props)` | 判断对象是否为合法服务注册信息 |

### `Container`

| 方法 | 说明 |
|------|------|
| `register(fn)` | 注册服务（同函数引用去重） |
| `resolve(props)` | 加载服务（执行、等待或返回缓存） |
| `hasService(fn)` | 检查函数是否已注册 |
| `hasMeta(id)` | 检查服务是否已有运行时元数据 |
| `getIdByService(fn)` | 通过函数获取服务 ID |
| `getMetaById(id)` | 通过 ID 获取运行时元数据 |
| `shutdown()` | 销毁所有服务并执行清理回调 |

### 服务状态

| 状态 | 值 | `resolve` 行为 |
|------|---|---------------|
| 未运行 | — | 执行服务函数 |
| 运行中 | `0` | 加入等待队列 |
| 已成功 | `1` | 返回缓存值 |
| 已失败 | `-1` | 返回缓存错误 |

## 开发

```bash
pnpm install
pnpm build
pnpm dev
pnpm test
```

## License

MIT
