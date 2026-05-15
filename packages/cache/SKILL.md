---
name: cache
description: Code generation and contribution rules for @hile/cache. Use when editing this package or when the user asks about @hile/cache API, types, patterns, or features.
---

# @hile/cache — AI Skill Reference

本文档面向 **AI 编码模型**。在生成或修改 `@hile/cache` 代码前必读，保证与现有架构、API 约定、测试模式一致。

---

## 1. 架构总览

### 依赖链

```
@hile/core (DI 容器)
  └── @hile/ioredis (Redis 服务: 环境变量配置 + 单例 + 自动断连)
        └── @hile/cache
              ├── define.ts — 类型安全 key 模板 + Cache 数据包装 + defineCache
              └── index.ts  — RedisCache 类: _read / _write / _remove / _has
```

### 分层职责

| 模块 | 文件 | 职责 | 关键约束 |
|------|------|------|---------|
| `defineCache` | `define.ts` | 定义缓存 key 模板 + 回源 handler | 模板中 `{name:type}` 占位符；type 只支持 `string`/`number`/`boolean` |
| `Cache<R>` | `define.ts` | 包装回源数据，携带 TTL | `expire: 0` 表示永不过期 |
| `RedisCache` | `index.ts` | Redis 读写操作，读穿透/回源写入/删除/存在判断 | 每次操作通过 `loadService(ioredisService)` 获取客户端 |

### 流程

```
read(params):
  → EXISTS key
    ├─ false → write(params): handler(params) → SET/SETEX → 返回
    └─ true  → GET key → JSON.parse → 返回

write(params):
  → handler(params) → Cache<R>
  ├─ cache.data === undefined → DEL key (若存在) → return
  └─ cache.data !== undefined →
       ├─ cache.expire > 0 → SETEX(key, expire, JSON.stringify(data))
       └─ cache.expire === 0 → SET(key, JSON.stringify(data))

remove(params):
  → EXISTS key → DEL key → 返回删除数量

has(params):
  → EXISTS key → 返回 boolean
```

---

## 2. 类型定义（代码生成时必须一致）

### define.ts

```typescript
export class Cache<R> {
  private _expire: number = 0; // 0: 永不过期
  constructor(public readonly data: R) { }
  public setExpire(seconds: number): this;
  get expire(): number;
}

/** 字面量路径解析 `{k:type}`；`T` 为宽 `string` 时退化为宽松索引类型 */
export type ExtractParams<Template extends string> =
  string extends Template
  ? Record<string, string | number | boolean>
  : Template extends `${string}{${infer Key}:${infer Type}}${infer Rest}`
  ? {
    [K in Key]: Type extends "string"
    ? string
    : Type extends "number"
    ? number
    : Type extends "boolean"
    ? boolean
    : never
  } & ExtractParams<Rest>
  : {};

export type DefineCacheHandler<T extends string = string, R = any> =
  (opts: ExtractParams<T>) => Promise<Cache<R>>;

export type DefineCacheResult<T extends string = string, R = any> = {
  fn: DefineCacheHandler<T, R>;
  key: string;
};

export function defineCache<T extends string = string, R = any>(
  key: T,
  fn: DefineCacheHandler<T, R>
): DefineCacheResult<T, R>;
```

### index.ts

```typescript
export class RedisCache {
  private readonly _regexp = /\{([^\:]+):[^\}]+\}/g;
  constructor(private readonly prefix: string) { }

  public loadCache<T extends string, R>(
    target: DefineCacheResult<T, R>
  ): Promise<{
    write(params: ExtractParams<T>): Promise<R | undefined>;
    read(params: ExtractParams<T>): Promise<R | undefined>;
    remove(params: ExtractParams<T>): Promise<number>;
    has(params: ExtractParams<T>): Promise<boolean>;
  }>;
}

export { defineCache, Cache, ExtractParams, DefineCacheHandler, DefineCacheResult } from './define';
```

---

## 3. 代码生成模板与规则

### 3.1 defineCache 模板

```typescript
// 基本模板
const myCache = defineCache('prefix:{id:string}:suffix', async (params) => {
  const data = await fetchData(params.id);
  if (!data) return new Cache(undefined); // 返回 undefined → Redis 中不存/删除
  return new Cache(data).setExpire(300);  // 5 分钟 TTL
});

// 多参数模板
const myCache = defineCache(
  'user:{id:string}:posts:{page:number}:{verified:boolean}',
  async ({ id, page, verified }) => {
    // params 类型自动推导为 { id: string; page: number; verified: boolean }
    const data = await db.query('SELECT * FROM posts WHERE ...');
    return new Cache(data).setExpire(60);
  }
);
```

### 3.2 RedisCache 使用模板

```typescript
// 单条缓存
const cache = new RedisCache('myapp:');
const { read, write, remove, has } = await cache.loadCache(myCache);

// 多条缓存
const [ops1, ops2] = await Promise.all([
  cache.loadCache(cache1),
  cache.loadCache(cache2),
]);
```

### 3.3 测试模板

```typescript
import { RedisCache, defineCache, Cache } from '@hile/cache';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// Mock Redis 的测试需要配合 @hile/ioredis 的 mock 或真实 Redis 实例
// 以下为使用真实 Redis 的集成测试模板:
describe('@hile/cache', () => {
  const cache = new RedisCache('test:');

  const testCache = defineCache('key:{id:string}', async ({ id }) => {
    return new Cache({ id, value: `hello-${id}` }).setExpire(60);
  });

  it('read returns data on cache hit', async () => {
    const { write, read, remove } = await cache.loadCache(testCache);

    // 先写入
    const written = await write({ id: '1' });
    expect(written).toEqual({ id: '1', value: 'hello-1' });

    // 读取
    const result = await read({ id: '1' });
    expect(result).toEqual({ id: '1', value: 'hello-1' });

    await remove({ id: '1' });
  });

  it('write with undefined data deletes existing key', async () => {
    const undefCache = defineCache('undef:{id:string}', async ({ id }) => {
      return new Cache(undefined);
    });
    const { write, has } = await cache.loadCache(undefCache);
    await write({ id: '1' });
    const exists = await has({ id: '1' });
    expect(exists).toBe(false);
  });

  it('remove returns 0 for non-existent key', async () => {
    const { remove } = await cache.loadCache(testCache);
    const count = await remove({ id: 'nonexistent' });
    expect(count).toBe(0);
  });

  it('has returns correct boolean', async () => {
    const { write, has, remove } = await cache.loadCache(testCache);
    await write({ id: '1' });
    expect(await has({ id: '1' })).toBe(true);
    await remove({ id: '1' });
    expect(await has({ id: '1' })).toBe(false);
  });
});
```

---

## 4. Redis key 规则

### key 渲染

`makeKey` 使用正则 `/\{([^\:]+):[^\}]+\}/g` 匹配模板占位符并替换为实际参数值：

```
template: "user:{id:string}:posts:{page:number}"
params:   { id: "u-001", page: 3 }
result:   "user:u-001:posts:3"
```

### 真实 Redis key

```
{prefix}{渲染后的 key}
```

例如 `prefix = "myapp:"` + 上例 → `myapp:user:u-001:posts:3`

---

## 5. 设计约束（必须遵守）

1. **每次操作都通过 `loadService(ioredisService)` 获取 Redis 客户端** — 不要缓存 `redis` 引用，由容器的并发合并和单例保证性能
2. **`_write` 中的 EXISTS 检查是为了处理 `data === undefined` 的 DELETE 场景** — 正常写入（`data !== undefined`）可考虑不必先 EXISTS（SET 是幂等的），但目前实现统一检查
3. **`_read` 的兜底逻辑 `if (!text) return this._write(...)`** — 防御 EXISTS 和 GET 之间的竞态删除，不可移除
4. **序列化统一使用 `JSON.stringify` / `JSON.parse`** — 不支持 Buffer、BigInt 等特殊类型
5. **Cache 的 `data` 为 `undefined` 时** — `_write` 会删除 Redis 中对应的 key（如果存在），且 `_write` 返回 `undefined`

---

## 6. 反模式（禁止）

1. **不要绕过 `loadService(ioredisService)` 直接创建 Redis 连接** — 会破坏容器的单例管理和 shutdown 清理
2. **不要假设 key 模板中参数顺序与渲染结果相同** — `makeKey` 使用正则替换，占位符可以出现在 key 的任何位置
3. **不要在 `Cache` 构造后将数据存到 `Cache` 外部** — `Cache` 的 `data` 是 `public readonly`，但仅供读取；数据变更应创建新的 `Cache`
4. **不要手动拼接 Redis key 字符串** — 必须使用 `defineCache` 的模板 + `makeKey` 渲染，保证一致性
5. **不要在 loadCache 之外直接调用 `_read`/`_write`/`_remove`/`_has`** — 这些方法以 `_` 开头表示内部实现，外部统一通过 `loadCache` 返回的操作对象调用

---

## 7. 文件改动范围

| 文件 | 可修改 | 说明 |
|------|--------|------|
| `packages/cache/src/index.ts` | ✅ | 核心 cache 操作 |
| `packages/cache/src/define.ts` | ⚠️ | 类型定义（修改需同步更新 ExtractParams 类型推导） |
| `packages/cache/src/index.test.ts` | ✅ | 测试 |
| `packages/cache/README.md` | ✅ | 用户文档 |
| `packages/cache/SKILL.md` | ✅ | AI 参考文档 |

---

## 8. 运行命令

```bash
pnpm --filter @hile/cache build    # 编译，必须通过
pnpm --filter @hile/cache test     # 测试，修改行为时必须覆盖
```
