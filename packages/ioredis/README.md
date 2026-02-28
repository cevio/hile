# @hile/ioredis

基于 `@hile/core` 的 Redis 集成：将 ioredis 客户端封装为 Hile 服务（单例、随进程退出断开连接）。

## 安装

```bash
pnpm add @hile/ioredis
```

依赖 `@hile/core` 与 `ioredis`，请一并安装。

## 快速开始

通过环境变量配置 Redis，用 `loadService` 获取客户端：

```typescript
import { loadService } from '@hile/core'
import ioredisService from '@hile/ioredis'

const redis = await loadService(ioredisService)
// 使用 redis.get/set 等 ioredis API
```

## 环境变量

客户端从以下环境变量读取配置：

| 变量 | 说明 |
|------|------|
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口（字符串会被转为数字） |
| `REDIS_USERNAME` | Redis 用户名 |
| `REDIS_PASSWORD` | Redis 密码 |
| `REDIS_DB` | Redis 数据库编号，默认 `0` |

行为：服务在首次加载时创建连接并等待 `connect` 事件；进程退出时通过 Hile 的 shutdown 调用 `client.disconnect()`。

## 与 @hile/cli 一起使用

若使用 `@hile/cli` 启动应用，可在项目根 `package.json` 中配置自动加载本包默认服务：

```json
{
  "hile": {
    "auto_load_packages": ["@hile/ioredis"]
  }
}
```

之后在业务中直接 `loadService(ioredisService)` 即可，Redis 客户端会在应用启动时连接、退出时断开。

## 开发

```bash
pnpm install
pnpm build    # 编译
pnpm dev      # 监听模式
pnpm test     # 测试
```

## License

MIT
