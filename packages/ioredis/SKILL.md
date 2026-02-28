# @hile/ioredis

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/ioredis` 在 `@hile/core` 之上提供：

- **默认导出**：一个通过 `defineService` 定义的 **ioredis Redis 客户端** 服务，配置来自环境变量；创建后等待 `connect` 事件再 resolve，进程退出时通过 `shutdown` 注册 `client.disconnect()`。

依赖：`@hile/core`、`ioredis`。生成代码时必须遵循 Hile 的服务定义与加载规则，通过 `loadService` 获取 Redis 实例并使用 ioredis 的标准 API。

---

## 2. 类型与环境变量

### 2.1 环境变量（默认服务）

| 变量 | 说明 |
|------|------|
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口（字符串会被转为数字） |
| `REDIS_USERNAME` | Redis 用户名 |
| `REDIS_PASSWORD` | Redis 密码 |
| `REDIS_DB` | Redis 数据库编号，未设置时默认为 `0` |

行为：服务在 `new Redis(options)` 后监听 `connect`，连接成功后才 resolve；`shutdown` 时调用 `client.disconnect()`。

### 2.2 类型（生成代码时须遵循）

- 默认服务：`defineService(async (shutdown) => { ... return client; })`，返回值为 ioredis 的 `Redis` 实例。
- 需要类型时从 `ioredis` 自行引入，例如 `import type { Redis, RedisOptions } from 'ioredis'`；本包仅导出默认服务，不 re-export 类型。

---

## 3. 代码生成模板与规则

### 3.1 使用默认服务

```typescript
import { loadService } from '@hile/core'
import ioredisService from '@hile/ioredis'

const redis = await loadService(ioredisService)
await redis.set('key', 'value')
const value = await redis.get('key')
```

### 3.2 规则与反模式

- 不要在本包外再包一层 `defineService` 封装同一个 Redis 连接；直接使用默认服务即可。
- 不要忽略环境变量：生产环境必须通过 `REDIS_*` 配置，避免硬编码。
- 需要扩展配置时，应在本包内扩展环境变量或 options 构造方式，保持单例由 Hile 管理。
