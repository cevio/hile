---
name: hile-core
description: @hile/core 的代码生成与使用规范。适用于定义/加载 Hile 服务、生命周期 shutdown 编排、或涉及 defineService、loadService、Container 等话题。
---

# @hile/core SKILL

本文档用于约束 AI 与开发者在使用 `@hile/core` 时的代码生成方式，目标是保证服务定义、依赖加载与资源销毁行为一致且可维护。

## 1. 架构概览

Hile 以 `Container` 为核心，服务遵循“定义 → 加载”两阶段：

- 单例：同一服务函数仅初始化一次
- 并发合并：并发加载同一服务时共享同一初始化过程
- 失败回收：初始化失败时自动执行已注册的清理回调

模块默认导出全局容器，并提供 `defineService` / `loadService` 便捷函数。

## 2. 关键类型

```typescript
type ServiceCutDownFunction = () => unknown | Promise<unknown>;
type ServiceCutDownHandler = (fn: ServiceCutDownFunction) => void;
type ServiceFunction<R> = (shutdown: ServiceCutDownHandler) => R | Promise<R>;

const sericeFlag = Symbol('service');

interface ServiceRegisterProps<R> {
  id: number;
  fn: ServiceFunction<R>;
  flag: typeof sericeFlag;
}
```

## 3. 标准模板

### 3.1 定义服务

```typescript
import { defineService } from '@hile/core'

export const xxxService = defineService(async (shutdown) => {
  const resource = await createResource()
  shutdown(() => resource.close())
  return resource
})
```

规则：

- 服务函数第一个参数固定为 `shutdown`
- 推荐必须使用 `async`
- `defineService` 结果需使用模块级 `export const` 暴露
- 命名建议以 `Service` 结尾

### 3.2 加载服务

```typescript
import { loadService } from '@hile/core'
import { databaseService } from './services/database'

const db = await loadService(databaseService)
```

规则：

- 始终通过 `loadService` 获取实例
- `loadService` 返回 Promise，必须 `await`

### 3.3 服务依赖服务

```typescript
import { defineService, loadService } from '@hile/core'
import { databaseService } from './database'

export const userService = defineService(async (shutdown) => {
  const db = await loadService(databaseService)
  return new UserRepository(db)
})
```

规则：

- 在服务函数内部加载依赖
- 不在模块顶层缓存 `loadService` 结果

### 3.4 注册清理回调

```typescript
export const connectionService = defineService(async (shutdown) => {
  const a = await connectA()
  shutdown(() => a.close())

  const b = await connectB()
  shutdown(() => b.close())

  return { a, b }
})
```

规则：

- 资源创建后立即注册清理
- 回调按 LIFO 执行
- 支持异步回调

### 3.5 全局优雅关闭

```typescript
import container from '@hile/core'

process.on('SIGTERM', async () => {
  await container.shutdown()
  process.exit(0)
})
```

## 4. 强制规则

1. 服务函数必须使用 `async`，避免同步 `throw` 破坏销毁机制。
2. 不要手动构造 `ServiceRegisterProps`。
3. 不要在工厂函数里动态调用 `defineService` 生成新引用。
4. 不要在模块顶层 `await loadService(...)`。
5. 每个外部资源都应对应一次 `shutdown` 注册。

## 5. 常见反模式

### 同步 throw

```typescript
// ✗
export const bad = defineService((shutdown) => {
  const r = createSync()
  shutdown(() => r.close())
  throw new Error('boom')
})

// ✓
export const good = defineService(async (shutdown) => {
  const r = await createAsync()
  shutdown(() => r.close())
  throw new Error('boom')
})
```

### 顶层缓存服务实例

```typescript
// ✗
const db = await loadService(databaseService)

// ✓
export async function query(sql: string) {
  const db = await loadService(databaseService)
  return db.query(sql)
}
```

## 6. API 速查

### 便捷函数

| 函数 | 说明 |
|---|---|
| `defineService(fn)` | 注册服务到默认容器 |
| `loadService(props)` | 加载服务实例 |
| `isService(props)` | 判断是否为合法服务注册对象 |

### Container

| 方法 | 说明 |
|---|---|
| `register(fn)` | 注册服务 |
| `resolve(props)` | 解析服务 |
| `hasService(fn)` | 检查函数是否已注册 |
| `hasMeta(id)` | 检查运行时元数据 |
| `getIdByService(fn)` | 通过函数获取 ID |
| `getMetaById(id)` | 通过 ID 获取元数据 |
| `shutdown()` | 销毁所有服务 |
