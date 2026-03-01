# @hile/typeorm

基于 `@hile/core` 的 TypeORM 集成：将 `DataSource` 封装为 Hile 服务（单例、可优雅销毁），并提供事务辅助函数 `transaction`。

## 安装

```bash
pnpm add @hile/typeorm
```

同时安装依赖：`@hile/core`、`typeorm`。

## 快速开始

```typescript
import { loadService } from '@hile/core'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)
// 使用 ds.getRepository(Entity)、ds.manager 等
```

## 环境变量

默认 DataSource 从以下环境变量读取配置：

| 变量 | 说明 |
|------|------|
| `TYPEORM_TYPE` | 数据库类型（如 `mysql`、`postgres`） |
| `TYPEORM_HOST` | 主机 |
| `TYPEORM_USERNAME` | 用户名 |
| `TYPEORM_PASSWORD` | 密码 |
| `TYPEORM_DATABASE` | 数据库名 |
| `TYPEORM_PORT` | 端口 |
| `TYPEORM_CHARSET` | 字符集 |
| `TYPEORM_ENTITY_PREFIX` | 实体表名前缀 |
| `TYPEORM_ENTITIES` | 实体目录（单一路径） |

行为说明：

- `synchronize: true`
- 当 `NODE_ENV === 'development'` 时启用 `logging`
- 未配置 `TYPEORM_ENTITIES` 时，实体数组为空
- 进程退出时通过 Hile 的 shutdown 自动销毁连接

## 事务辅助

使用 `transaction` 在 DataSource 上执行事务，并注册失败时的回滚逻辑（LIFO）：

```typescript
import { loadService } from '@hile/core'
import { transaction } from '@hile/typeorm'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)

const result = await transaction(ds, async (runner, rollback) => {
  // 用 runner 执行数据库操作
  rollback(() => {
    // 事务失败时执行的补偿逻辑
  })

  return value
})
```

- 成功：提交事务并返回回调结果
- 失败：回滚事务，并按后进先出顺序执行 `rollback(fn)` 注册函数，最后抛出原错误

## 与 @hile/cli 一起使用

可在 `package.json` 配置自动加载：

```json
{
  "hile": {
    "auto_load_packages": ["@hile/typeorm"]
  }
}
```

这样应用启动时会初始化 DataSource，退出时自动销毁。

## 开发

```bash
pnpm install
pnpm build
pnpm dev
pnpm test
```

## License

MIT
