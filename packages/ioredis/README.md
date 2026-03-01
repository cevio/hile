# @hile/ioredis

基于 `@hile/core` 的 Redis 集成：将 ioredis 客户端封装为 Hile 服务（单例、可优雅断连）。

## 安装

```bash
pnpm add @hile/ioredis
```

同时安装依赖：`@hile/core`、`ioredis`。

## 快速开始

```typescript
import { loadService } from '@hile/core'
import ioredisService from '@hile/ioredis'

const redis = await loadService(ioredisService)
// 使用 redis.get/set 等 ioredis API
```

## 环境变量

默认客户端从以下环境变量读取配置：

| 变量 | 说明 |
|------|------|
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口（字符串会转为数字） |
| `REDIS_USERNAME` | Redis 用户名 |
| `REDIS_PASSWORD` | Redis 密码 |
| `REDIS_DB` | Redis 数据库编号，默认 `0` |

行为说明：

- 服务首次加载时创建连接并等待 `connect` 事件
- 进程退出时通过 Hile 的 shutdown 调用 `client.disconnect()`

## 与 @hile/cli 一起使用

可在 `package.json` 配置自动加载：

```json
{
  "hile": {
    "auto_load_packages": ["@hile/ioredis"]
  }
}
```

这样应用启动时会自动建立 Redis 连接，退出时自动断开。

## 开发

```bash
pnpm install
pnpm build
pnpm dev
pnpm test
```

## License

MIT
