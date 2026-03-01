---
name: hile-core
description: `@hile/core` 的代码生成与使用规范。适用于定义/加载 Hile 服务、生命周期编排、依赖图与容器事件相关场景。
---

# @hile/core SKILL

本文档面向代码生成器与维护者，目标是确保生成代码严格符合容器语义。

## 1. 强约束（必须遵守）

1. 服务必须使用 `async (shutdown)` 形态定义。
2. 只能通过 `defineService` / `container.register` 产出服务对象。
3. 只能通过 `loadService` / `container.resolve` 获取服务实例。
4. 外部资源创建后必须立即注册 `shutdown`。
5. 禁止在模块顶层缓存 `await loadService(...)` 结果。
6. 依赖服务必须在服务函数内部加载。
7. 多个 teardown 默认按 LIFO 顺序执行。

## 2. 生命周期与超时约束

容器生命周期：`init -> ready -> stopping -> stopped`。

- 启动超时：`new Container({ startTimeoutMs })`
- 销毁超时：`new Container({ shutdownTimeoutMs })`

生成代码时：

- 不要吞掉启动超时错误。
- 不要假设 teardown 一定成功；应允许 `service:shutdown:error` 事件出现。

## 3. 可观测事件约束

允许订阅：`container.onEvent(listener)`。

关键事件：

- `service:init`
- `service:ready`
- `service:error`
- `service:shutdown:start`
- `service:shutdown:done`
- `service:shutdown:error`
- `container:shutdown:start`
- `container:shutdown:done`
- `container:error`

规则：

- 订阅后必须在生命周期结束时取消订阅。
- 记录错误时保留原始 error 对象。

## 4. 依赖图与循环依赖

容器会自动记录服务依赖并检测循环依赖：

- `getDependencyGraph()`
- `getStartupOrder()`

规则：

- 不要绕开容器手动构建“隐式全局单例依赖”。
- 出现 `circular dependency detected` 时应通过拆分服务职责或引入中间层服务解决。

## 5. 反模式（禁止）

### 5.1 顶层缓存实例

```typescript
// ✗
const db = await loadService(dbService)

// ✓
export async function query(sql: string) {
  const db = await loadService(dbService)
  return db.query(sql)
}
```

### 5.2 手动伪造服务对象

```typescript
// ✗
const fake = { id: 1, fn: async () => 1 }

// ✓
const real = defineService(async () => 1)
```

### 5.3 不注册资源清理

```typescript
// ✗
export const bad = defineService(async () => {
  return await createPool()
})

// ✓
export const good = defineService(async (shutdown) => {
  const pool = await createPool()
  shutdown(() => pool.end())
  return pool
})
```

## 6. 边界条件清单

- [ ] 服务同步抛错路径是否可观测
- [ ] 异步 reject 路径是否会触发 teardown
- [ ] teardown 抛错是否不覆盖原始业务错误
- [ ] 并发 resolve 同一服务是否只初始化一次
- [ ] shutdown 重复调用是否幂等
