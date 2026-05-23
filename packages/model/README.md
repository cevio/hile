# @hile/model

定义和调用业务模型（model），支持 services 依赖注入和中间件 pipeline。

## 它解决什么问题？

应用中的业务逻辑如果散落在 API 控制器、页面组件和服务中，会变得难以测试和复用。`@hile/model` 提供一个统一的层来封装领域逻辑：

- **业务逻辑集中**：每个模型文件包含一个 `defineModel`，业务逻辑不再散落
- **可选依赖注入**：支持声明 services 依赖，自动 `loadService` 后透传给 main 函数
- **中间件 pipeline**：支持 Koa 风格中间件链，可在业务逻辑前后执行横切关注点（日志、鉴权、事务等）
- **与服务容器解耦**：不同于 `@hile/core` 的容器单例，每次 `loadModel` 都重新执行 `main`，适合请求级别的上下文

## 安装

```bash
pnpm add @hile/model
```

依赖 `@hile/core`（workspace peer dependency）。

## 快速开始

```typescript
import { defineModel, loadModel } from '@hile/model'

const greetModel = defineModel(async (input: { name: string }) => {
  return `Hello, ${input.name}!`
})

const result = await loadModel(greetModel, { name: 'World' })
console.log(result) // Hello, World!
```

## 使用指南

### 基础模型（无 services）

一个输入、一个输出：

```typescript
// src/models/greet.model.ts
import { defineModel } from '@hile/model'
export default defineModel(async (input: { name: string }) => {
  return { greeting: `Hello, ${input.name}!` }
})
```

```typescript
// 消费
import { loadModel } from '@hile/model'
import greetModel from '@/models/greet.model'

const result = await loadModel(greetModel, { name: 'World' })
```

### 注入 services

通过 `services` 声明依赖，`main` 的第一个参数是加载后的 services 实例元组：

```typescript
import { defineModel } from '@hile/model'
import { defineService } from '@hile/core'

const userService = defineService('user', async () => ({
  findById: async (id: number) => ({ id, name: 'Alice' }),
}))

const getUserModel = defineModel({
  services: [userService],
  async main([user], input: { id: number }) {
    return user.findById(input.id)
  },
})
```

services 数组与 main 首参元组顺序一致。

### 中间件 pipeline

Koa 风格中间件链，在 `main` 前后执行横切逻辑：

```typescript
import { defineModel, type PipelineMiddleware } from '@hile/model'

const logger: PipelineMiddleware = async (ctx, next) => {
  console.log('before:', ctx.args)
  await next()
  console.log('after')
}

const model = defineModel({
  pipelines: [logger],
  async main(input: { id: number }) {
    return fetchUser(input.id)
  },
})
```

中间件特性：

- 通过 `ctx.args` 改写入参
- 通过 `ctx.state` 在中间件间传递数据
- 不调 `next()` 可短路，`main` 不会执行
- 最后一个中间件不应调 `next()`

### 函数简写

无 services 和 pipelines 时可直接传入 `main`：

```typescript
const model = defineModel(async (input: { id: number }) => input.id)
// 等价于
const model = defineModel({ main: async (input: { id: number }) => input.id })
```

## API 参考

### 顶层导出

| 导出 | 说明 |
|------|------|
| `defineModel` | 定义业务模型 |
| `loadModel` | 执行模型，返回 `Promise<R>` |
| `isModel` | 校验对象是否合法 `ModelDefinition` |
| `Pipeline` | pipeline 类 |
| `PipelineContext` | pipeline 上下文 |
| `ModelDefinition` | 模型类型 |
| `ModelProps` | `defineModel` 入参类型 |
| `ModelFlag` | 模型内部标记类型 |
| `PipelineMiddleware` | 中间件类型 |
| `ModelPipeline` | pipeline 中间件列表类型 |
| `InferServiceResult` | 从 `ServiceRegisterProps` 推断服务实例类型 |
| `InferredServices` | services 元组 → 实例元组类型 |

### defineModel

```typescript
// 简写形式
defineModel<TInput extends object, R>(
  main: (input: TInput) => R | Promise<R>,
): ModelDefinition<TInput, R>

// 完整形式
defineModel<S, TInput, R>(
  options: ModelProps<S, TInput, R>,
): ModelDefinition<TInput, R>
```

### ModelProps

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `main` | `function` | 是 | 业务函数。有 services 时首参为实例元组，次参为 input；否则仅 input |
| `services` | `ServiceRegisterProps[]` | 否 | 依赖的服务列表，自动 `loadService` |
| `pipelines` | `PipelineMiddleware[]` | 否 | Koa 风格中间件列表 |

### ModelDefinition

```typescript
interface ModelDefinition<TInput extends object, R> {
  readonly flag: symbol
  readonly handler: (input: TInput) => Promise<R>
}
```

### loadModel

```typescript
loadModel<TInput extends object, R>(
  model: ModelDefinition<TInput, R>,
  input: TInput,
): Promise<R>
```

非容器单例，每次调用都重新执行 `main`。首参非 `defineModel` 返回值时抛 `TypeError`。

### Pipeline

| 方法 | 说明 |
|------|------|
| `use(fn)` | 注册中间件 |
| `dispatch(ctx)` | 启动中间件链，返回 `Promise<void>` |

### PipelineContext

| 属性 | 类型 | 说明 |
|------|------|------|
| `args` | `TInput` | 原始入参，中间件可改写 |
| `state` | `Record<string, unknown>` | 中间件间共享状态 |

## License

MIT
