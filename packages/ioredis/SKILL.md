---
name: hile-ioredis
description: @hile/ioredis 的代码生成与使用规范。适用于 Redis 服务加载、环境变量配置、及与 @hile/core/@hile/cli 集成场景。
---

# @hile/ioredis SKILL

本文档规范 `@hile/ioredis` 的使用方式，确保 Redis 客户端生命周期由 Hile 统一管理。

## 1. 架构概览

`@hile/ioredis` 提供一个默认导出的 Hile 服务：

- 使用环境变量构建 ioredis 客户端
- 首次加载时建立连接并等待 `connect`
- 进程退出时调用 `client.disconnect()`

依赖：`@hile/core`、`ioredis`。

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `REDIS_HOST` | Redis 主机 |
| `REDIS_PORT` | Redis 端口（字符串转数字） |
| `REDIS_USERNAME` | Redis 用户名 |
| `REDIS_PASSWORD` | Redis 密码 |
| `REDIS_DB` | Redis 数据库编号（默认 `0`） |

## 3. 标准模板

### 3.1 加载默认服务

```typescript
import { loadService } from '@hile/core'
import ioredisService from '@hile/ioredis'

const redis = await loadService(ioredisService)
await redis.set('key', 'value')
const value = await redis.get('key')
```

## 4. 强制规则

1. 统一通过 `loadService(ioredisService)` 获取 Redis 客户端。
2. 不要再额外封装一个同用途的全局 Redis 单例与本包混用。
3. 生产环境应通过 `REDIS_*` 变量配置，避免硬编码。
4. 依赖 Redis 的服务应在服务函数内部加载，不在模块顶层缓存实例。

## 5. API 速查

| 导出 | 说明 |
|---|---|
| 默认导出 | Hile 服务化 Redis 客户端 |
