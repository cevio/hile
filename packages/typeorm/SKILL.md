---
name: hile-typeorm
description: `@hile/typeorm` 的代码生成与使用规范。适用于 DataSource 服务加载、transaction 事务封装、及与 @hile/core/@hile/cli 集成场景。
---

# @hile/typeorm SKILL

本文档规范 `@hile/typeorm` 的使用方式，确保 DataSource 生命周期与事务行为一致。

## 1. 架构概览

`@hile/typeorm` 提供：

- 默认导出：Hile 服务化的 TypeORM `DataSource`
- `transaction`：事务封装，支持失败时 LIFO 执行补偿回调

依赖：`@hile/core`、`typeorm`。

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `TYPEORM_TYPE` | 数据库类型 |
| `TYPEORM_HOST` | 主机 |
| `TYPEORM_USERNAME` | 用户名 |
| `TYPEORM_PASSWORD` | 密码 |
| `TYPEORM_DATABASE` | 数据库名 |
| `TYPEORM_PORT` | 端口（字符串转数字） |
| `TYPEORM_CHARSET` | 字符集 |
| `TYPEORM_ENTITY_PREFIX` | 表名前缀 |
| `TYPEORM_ENTITIES` | 实体目录（单一路径） |

行为：

- `synchronize: true`
- `NODE_ENV === 'development'` 时 `logging: true`
- 未设置 `TYPEORM_ENTITIES` 时实体为空数组

## 3. 标准模板

### 3.1 加载默认 DataSource 服务

```typescript
import { loadService } from '@hile/core'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)
```

### 3.2 事务执行与补偿

```typescript
import { transaction } from '@hile/typeorm'

const result = await transaction(ds, async (runner, rollback) => {
  rollback(async () => {
    // 事务失败时执行的补偿逻辑
  })

  // 使用 runner 执行写操作
  return value
})
```

## 4. 强制规则

1. 统一通过 `loadService(typeormService)` 获取 DataSource。
2. 不在多个模块里自行 new 全局 DataSource 与本包混用。
3. 需要失败补偿时，使用 `rollback(fn)` 注册，不在事务外分散处理。
4. 依赖 DataSource 的服务在函数内部 `loadService`，不要模块顶层缓存。

## 5. API 速查

| 导出 | 说明 |
|---|---|
| 默认导出 | Hile 服务化 DataSource |
| `transaction(datasource, callback)` | 事务封装，失败时执行 rollback 队列 |
