---
name: model
description: "@hile/model: defineModel/loadModel 定义和消费模型；services 依赖注入；pipeline 中间件链；每次 loadModel 重新执行 main"
---

# @hile/model

与仓库根 **`SKILL.md`** 一并遵守。

## 核心概念

- **模型（Model）**：封装一段业务逻辑，通过 `defineModel` 定义，`loadModel` 执行
- **Services 注入**：通过 `services` 声明依赖，`main` 首参为加载后的实例元组
- **Pipeline**：Koa 风格中间件链，在 `main` 前后执行横切逻辑
- **非单例**：每次 `loadModel` 都重新执行 `main`，不同于 `@hile/core` 的容器单例

## 导出

| 名称 | 说明 |
|------|------|
| `defineModel` | 定义模型，接收 `(main)` 简写或 `ModelProps` 对象 |
| `loadModel` | `loadModel(model, input)` 执行模型 |
| `isModel` | 判断值是否为 `defineModel` 返回值 |
| `ModelDefinition` | 模型类型 |
| `ModelProps` | `defineModel` 入参类型 |
| `ModelPipeline` | `readonly PipelineMiddleware[]` |
| `Pipeline` | 中间件链类 |
| `PipelineContext` | 中间件上下文 |
| `PipelineMiddleware` | 中间件类型 `(ctx, next) => Promise<void>` |
| `InferServiceResult` | 工具类型 |
| `InferredServices` | 工具类型 |

## 用法规则

### defineModel

```typescript
// 简写：无 services、无 pipelines
defineModel(async (input: TInput) => R)

// 完整形式
defineModel({
  services?: [ServiceA, ServiceB],       // 可选
  pipelines?: [MiddlewareA, MiddlewareB], // 可选，顺序执行
  async main(
    services?: [InstanceA, InstanceB],    // 有 services 时首参
    input: TInput,                        // 入参
  ): R | Promise<R>,
})
```

### 强制规则

1. **模型文件**：一个文件一个 `defineModel`，`export default`
2. **`loadModel` 首参**：必须是 `defineModel` 返回值，否则抛 `TypeError`
3. **Pipeline 原则**：
   - 最后一个中间件不应调用 `next()`，否则抛错
   - 中间件短路（不调 `next()`）会使 `main` 不执行
   - 中间件可通过 `ctx.args` 改写入参
   - 中间件间通过 `ctx.state` 传递数据
4. **Services**：同一 key 的 service 由 `@hile/core` 容器保证单例；model 本身不缓存结果

## 反模式

- 请求内调用 `defineModel`（应在模块顶层定义一次）
- 手动构造 `ModelDefinition` 对象（必须通过 `defineModel`）
- 在 `main` 中做副作用不返回结果（model 应是有输入有输出的纯业务函数）

## 测试

**`src/model.test.ts`**：`defineModel` 各种形式（完整、简写、services、pipelines）。**`src/pipeline.test.ts`**：中间件顺序、短路、next 多次调用、并发、无中间件等。
