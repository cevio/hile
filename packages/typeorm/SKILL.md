# @hile/typeorm

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/typeorm` 在 `@hile/core` 之上提供：

- **默认导出**：一个通过 `defineService` 定义的 TypeORM **DataSource** 服务，配置来自环境变量，进程退出时通过 `shutdown` 注册 `connection.destroy()`。
- **transaction**：事务封装函数，接收 DataSource 与回调，在回调内提供 `QueryRunner` 与 `rollback` 注册器；提交成功则返回结果，失败则回滚并按 LIFO 执行已注册的 rollback 回调。

依赖：`@hile/core`、`typeorm`。生成代码时必须遵循 Hile 的服务定义与加载规则，并正确使用本包默认服务与 `transaction` 签名。

---

## 2. 类型与环境变量

### 2.1 环境变量（DataSource 默认服务）

| 变量 | 说明 |
|------|------|
| `TYPEORM_TYPE` | 数据库类型 |
| `TYPEORM_HOST` | 主机 |
| `TYPEORM_USERNAME` | 用户名 |
| `TYPEORM_PASSWORD` | 密码 |
| `TYPEORM_DATABASE` | 数据库名 |
| `TYPEORM_PORT` | 端口（字符串会被转为数字） |

DataSource 行为：`synchronize: true`；`logging` 在 `NODE_ENV === 'development'` 时为 `true`。

### 2.2 类型（生成代码时须遵循）

- 使用 `typeorm` 的 `DataSource`、`DataSourceOptions`、`QueryRunner`。
- **transaction** 签名：

```typescript
function transaction<T>(
  datasource: DataSource,
  callback: (
    runner: QueryRunner,
    rollback: (roll: () => unknown | Promise<unknown>) => number
  ) => Promise<T>
): Promise<T>;
```

- 默认服务：`defineService(async (shutdown) => { ... return connection; })`，在 `connection.initialize()` 前 `shutdown(() => connection.destroy())`。

---

## 3. 代码生成模板与规则

### 3.1 使用默认 DataSource 服务

**模板：**

```typescript
import { loadService } from '@hile/core'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)
// 使用 ds 进行 TypeORM 操作
```

**规则：**
- 仅通过 `loadService(默认导出)` 获取 DataSource，不要自行 `new DataSource` 并暴露为“全局数据源”与 Hile 并存。
- 环境变量在应用启动前必须配置完整，否则 DataSource 初始化可能失败。

### 3.2 在事务中执行并注册回滚

**模板：**

```typescript
import { loadService } from '@hile/core'
import { transaction } from '@hile/typeorm'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)

const result = await transaction(ds, async (runner, rollback) => {
  // 使用 runner 进行查询/写入
  rollback(() => { /* 业务级回滚逻辑，失败时 LIFO 执行 */ })
  return value
})
```

**规则：**
- 第一个参数必须是 `DataSource` 实例（通常来自 `loadService(typeormService)`）。
- 回调内需要“事务失败时执行”的逻辑通过 `rollback(fn)` 注册，不要依赖在回调外再执行清理。

### 3.3 与 @hile/core 的约定

- 本包默认导出是 Hile 服务（`defineService`），遵循 core 的 SKILL：服务函数为 `async (shutdown)`，资源创建后立即 `shutdown(() => connection.destroy())`。
- 其他服务若依赖 DataSource，应在该服务函数内 `loadService(typeormService)` 获取，不要在模块顶层缓存 DataSource。

### 3.4 反模式

- **不要**在未通过 Hile 加载的情况下，多处自行 `new DataSource` 并与本包默认服务混用。
- **不要**在 `transaction` 回调外依赖“事务未提交”的状态做后续逻辑；提交/回滚由 `transaction` 内部统一处理。
- **不要**省略 `shutdown(() => connection.destroy())` 或将其放在 `initialize()` 之后才注册（应在连接初始化前注册，与源码一致）。

---

## 4. API 速查

| 导出 | 说明 |
|------|------|
| 默认导出 | `defineService` 返回的 DataSource 服务（需通过 `loadService` 使用） |
| `transaction(datasource, callback)` | 在 DataSource 上执行事务，回调接收 `(runner, rollback)`，返回 `Promise<T>` |
