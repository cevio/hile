# @hile/cache

基于 Redis 的类型安全读穿透缓存层。依赖 `ioredis`，构造时注入已连接的 `Redis` 实例（可与 `@hile/ioredis` 配合使用）。

从 3.0.0 开始，新增或重构的 Hile 架构包统一进入 3.x 版本线，2.x 时代结束。

## 安装

```bash
pnpm add @hile/cache
```

运行时需提供 `ioredis` 的 `Redis` 实例；在 Hile 应用中通常通过 `@hile/ioredis` 的 `createRedis()` 或 `loadService(ioredisService)` 获取。

## 快速开始

### 1. 定义缓存

使用 `defineCache` 定义一条缓存：指定 key 模板和回源函数。

```typescript
import { defineCache, Cache } from '@hile/cache';

const userCache = defineCache('user:{id:string}:info', async (params) => {
  // params 的类型自动推导为 { id: string }
  const data = await fetchUserFromDB(params.id);
  return new Cache(data).setExpire(300); // 5 分钟 TTL
}, {
  singleflight: true,
  stale: { ttl: 60 },
  negative: { ttl: 30 },
  tags: ({ id }) => ['users', `user:${id}`],
});
```

### 2. 使用缓存

```typescript
import { loadService } from '@hile/core';
import redisService from '@hile/ioredis';
import { RedisCache } from '@hile/cache';

const redis = await loadService(redisService);
const cache = new RedisCache('myapp:', redis); // 前缀 + Redis 实例

const { read, write, remove, has } = await cache.loadCache(userCache);

// 读穿透：miss 时自动回源并写入
const user = await read({ id: 'u-001' });

// 强制刷新
await write({ id: 'u-001' });

// 判断是否存在
const exists = await has({ id: 'u-001' });

// 删除
await remove({ id: 'u-001' });

// 按 tag 批量失效
await cache.removeTag('users');
```

---

## 核心概念

### 类型安全 key 模板

key 模板使用 `{name:type}` 占位符，编译期自动推导参数类型：

```typescript
defineCache('user:{id:string}:posts:{page:number}:{verified:boolean}', ...)
// params → { id: string; page: number; verified: boolean }
```

支持的类型：`string`、`number`、`boolean`。

### Cache 类

`Cache<R>` 包装回源数据，提供 TTL 控制：

| 方法 | 说明 |
|------|------|
| `new Cache(data)` | 创建缓存数据，expire=0 永不过期 |
| `.setExpire(seconds)` | 设置 TTL（秒） |

### 读穿透（Read-Through）

`RedisCache._read` 的调用链路：

```
read(params)
  → EXISTS key
    ├─ true  → GET key → JSON.parse → 返回
    └─ false → write(params) → handler 回源 → SET/SETEX → 返回
```

### Singleflight

`singleflight` 使用 `@hile/redis-lock` 合并同一个 key 的并发 miss，避免热点 key 同时打到数据库。

```typescript
const userCache = defineCache('user:{id:string}', fetchUser, {
  singleflight: {
    ttl: 10_000,
    wait: 10_000,
  },
});
```

### Stale Cache

`stale: { ttl }` 会在数据过了 `Cache#setExpire()` 的 fresh 时间后继续保留一段 stale 时间。读取 stale 数据时立即返回旧值，并在后台刷新。

### Negative Cache

默认 `new Cache(undefined)` 不写 Redis。配置 `negative: { ttl }` 后会写入一个短 TTL 哨兵，避免不存在的数据反复回源。

### Tags

`tags` 会把缓存 key 记录到 Redis set，之后可用 `cache.removeTag(tag)` 批量删除。

---

## API 参考

### defineCache

```typescript
function defineCache<T extends string = string, R = any>(
  key: T,
  fn: (params: ExtractParams<T>) => Promise<Cache<R>>,
  options?: boolean | DefineCacheOptions<T, R>
): DefineCacheResult<T, R>;
```

第三个参数仍兼容旧的 `boolean` fieldable 写法；新能力使用 options 对象。

> `fieldable` 使用 Redis Hash 存储，不兼容 `stale` 和 `negative` 这类依赖字符串 payload 的策略；组合使用会在 `defineCache()` 阶段直接抛出配置错误。

### RedisCache

```typescript
class RedisCache {
  constructor(prefix: string, redis: Redis, options?: { locks?: RedisLock });

  loadCache<T extends string, R>(
    target: DefineCacheResult<T, R>
  ): Promise<{
    write(params: ExtractParams<T>): Promise<R | undefined>;
    read(params: ExtractParams<T>): Promise<R | undefined>;
    remove(params: ExtractParams<T>): Promise<number>;
    has(params: ExtractParams<T>): Promise<boolean>;
  }>;

  removeTag(tag: string): Promise<number>;
}
```

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `read` | `R \| undefined` | 读穿透：EXISTS → GET / miss 则回源写入 |
| `write` | `R \| undefined` | 强制执行回源并写入 Redis（data=undefined 则删除 key） |
| `remove` | `number` | 删除缓存，返回 0/1 |
| `has` | `boolean` | 检查 key 是否存在 |
| `removeTag` | `number` | 删除某个 tag 下记录的所有缓存 key |

### Redis 中的 key 结构

```
{prefix}{key模板渲染结果}
```

例如 `prefix = "myapp:"`、key 模板为 `user:{id:string}:info`、params 为 `{ id: "u-001" }` 时：
```
myapp:user:u-001:info
```

---

## 与 @hile/cli 集成

在 `package.json` 中配置自动加载 Redis，在 boot 或服务工厂里注入客户端：

```json
{
  "hile": {
    "auto_load_packages": ["@hile/ioredis"]
  }
}
```

```typescript
import { loadService } from '@hile/core';
import redisService from '@hile/ioredis';
import { defineCache, Cache, RedisCache } from '@hile/cache';

// 在 defineService 工厂内
const redis = await loadService(redisService);
const cache = new RedisCache('myapp:', redis);
```

---

## 完整示例

```typescript
import { loadService } from '@hile/core';
import redisService from '@hile/ioredis';
import { defineCache, Cache, RedisCache } from '@hile/cache';

const redis = await loadService(redisService);

// 定义多条缓存
const userCache = defineCache('user:{id:string}:info', async ({ id }) => {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
  if (!user) return new Cache(undefined); // 不写入 Redis
  return new Cache(user).setExpire(600);
});

const postCache = defineCache('post:{id:string}:detail', async ({ id }) => {
  const post = await db.query('SELECT * FROM posts WHERE id = $1', [id]);
  return new Cache(post).setExpire(3600);
});

const cache = new RedisCache('myapp:', redis);

// 批量加载
const [userOps, postOps] = await Promise.all([
  cache.loadCache(userCache),
  cache.loadCache(postCache),
]);

// 使用
const user = await userOps.read({ id: 'u-001' });
const post = await postOps.read({ id: 'p-001' });
```

---

## License

MIT
