# @hile/typeorm

基于 `@hile/core` 的 TypeORM 集成：将 TypeORM DataSource 封装为 Hile 服务（单例、随进程退出销毁），并提供事务封装 `transaction`。

## 安装

```bash
pnpm add @hile/typeorm
```

依赖 `@hile/core` 与 `typeorm`，请一并安装。

## 快速开始

通过环境变量配置数据库，用 `loadService` 获取 DataSource：

```typescript
import { loadService } from '@hile/core'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)
// 使用 ds.getRepository(Entity)、ds.manager 等
```

## 环境变量

DataSource 从以下环境变量读取配置：

| 变量 | 说明 |
|------|------|
| `TYPEORM_TYPE` | 数据库类型（如 `mysql`、`postgres`） |
| `TYPEORM_HOST` | 主机 |
| `TYPEORM_USERNAME` | 用户名 |
| `TYPEORM_PASSWORD` | 密码 |
| `TYPEORM_DATABASE` | 数据库名 |
| `TYPEORM_PORT` | 端口 |

行为：`synchronize: true`；当 `NODE_ENV === 'development'` 时开启 `logging`。连接在进程退出时通过 Hile 的 shutdown 自动销毁。

## 事务

使用 `transaction` 在 DataSource 上执行事务，并在失败时执行已注册的回滚逻辑（LIFO）：

```typescript
import { loadService } from '@hile/core'
import { transaction } from '@hile/typeorm'
import typeormService from '@hile/typeorm'

const ds = await loadService(typeormService)

const result = await transaction(ds, async (runner, rollback) => {
  // 使用 runner 进行查询/写入
  rollback(() => {
    // 事务失败时执行的清理（如撤销外部副作用）
  })
  return value
})
```

- 成功：`transaction` 提交并返回回调的返回值。
- 失败：回滚事务并按后进先出顺序执行所有通过 `rollback(fn)` 注册的函数，再抛出原错误。

## 与 @hile/cli 一起使用

若使用 `@hile/cli` 启动应用，可在项目根 `package.json` 中配置自动加载本包默认服务：

```json
{
  "hile": {
    "auto_load_packages": ["@hile/typeorm"]
  }
}
```

之后在业务中直接 `loadService(typeormService)` 即可，DataSource 会在应用启动时初始化、退出时销毁。

## 开发

```bash
pnpm install
pnpm build    # 编译
pnpm dev      # 监听模式
pnpm test     # 测试
```

## License

MIT
