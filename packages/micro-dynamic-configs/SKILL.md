---
name: micro-dynamic-configs
description: Code generation and contribution rules for @hile/micro-dynamic-configs. Use when editing this package or when the user asks about dynamic config patterns or API.
---

# @hile/micro-dynamic-configs

面向 AI 编码模型与维护者的代码生成规范。阅读后应能正确使用本库编写符合架构规则的代码。

---

## 1. 架构总览

通过 `@hile/micro` 的 pub/sub 机制推送配置变更，每个 schema 字段一个独立 topic。

```
Publisher                    Config Server                       Subscriber
    │                             │                                  │
    │   save({ key: val })        │                                  │
    ├──────────────────────────►  │                                  │
    │                             │  publisher.update(newValue)      │
    │                             │  ──────────────────────────────► │
    │                             │  (通过 Registry 广播 topic)       │
    │                             │                                  │
    │                             │  app.subscribe('ns:key', cb)     │
    │                             │  ◄────────────────────────────── │
```

- **Config Server** (`MicroDynamicConfigsServer`) — 持有配置数据，校验、持久化，通过 `app.publish` 注册 publisher
- **Subscriber** — 直接用 `app.subscribe(topic, callback)` 接收推送，无需客户端层
- **Publisher** — 调用 `server.save()` 修改配置，数据流：validate → Redis 持久化 → 内存更新 → `publisher.update()` → `change:key` 事件

---

## 2. 类型签名

### MicroDynamicConfigsServer

```typescript
class MicroDynamicConfigsServer<
  T extends Application,
  Z extends ZodObject<ZodRawShape>
> extends EventEmitter

constructor(options: {
  app: T           // Application 实例
  redis: Redis     // ioredis 实例
  schema: Z        // Zod schema 定义配置结构
  redis_key: string // Redis 存储键名
})

// 从 Redis 加载持久化数据，为每个 schema 字段注册 publisher，返回 teardown 函数
initialize(): Promise<() => Promise<void>>

// 持久化并推送变更
save(value: Partial<z.infer<Z>>): Promise<number>

// 当前配置快照（只读）
get value(): z.infer<Z>
```

### 事件

| 事件 | 参数 | 说明 |
|------|------|------|
| `change:{field}` | `(newValue, oldValue)` | 字段变更时触发，每个字段独立事件名 |

---

## 3. Topic 约定

每个 schema 字段一个 topic，格式为：

```
{namespace}:{field}
```

例如 namespace `config-svc`、字段 `name`、`port`、`debug`：

- `config-svc:name`
- `config-svc:port`
- `config-svc:debug`

### 订阅

```typescript
const values: Record<string, any> = {};
const unsub = await app.subscribe('config-svc:name', (v) => values.name = v);
// unsub() 取消订阅
```

---

## 4. 代码生成强制规则

### 4.1 save() 必须分两轮执行

```typescript
// ✓ 正确：先 validate 再 apply
// Pass 1: validate & diff
const entries = [];
for (const key of keys) {
  const parsed = schema.parse(value[key]);
  if (!deepEqual(old, parsed)) entries.push({ key, parsed });
}
// Pass 2: persist → memory → publish + emit
await redis.set(key, JSON.stringify(next));
update memory;
emit 'change:{key}' events;

// ✗ 禁止：validate 和 mutate 混在一轮
for (const key of keys) {
  this._value[key] = parsed;  // ❌ 后续字段失败时 _value 已脏
}
```

### 4.2 initialize() 中注册 publisher

```typescript
// ✓ 正确：initialize 时调用 app.publish 注册所有字段
const publisher = await this.app.publish(`${namespace}:${key}`, initialValue);
this.publishers.set(key, publisher);

// save 时通过 publisher.update 推送
await this.publishers.get(key)!.update(newValue);

// teardown 时 unpublish
await publisher.unpublish();

// ✗ 禁止：save 中每次调用 app.publish（应复用 initialize 时注册的 publisher）
```

### 4.3 teardown 必须清理所有资源

```typescript
// ✓ 正确：teardown 需 unpublish + clear + removeAllListeners
return async () => {
  for (const publisher of this.publishers.values()) {
    await publisher.unpublish();
  }
  this.publishers.clear();
  this.removeAllListeners();
};
```

### 4.4 deep diff 避免无效推送

```typescript
// ✓ 正确：值未变化时跳过 publish
if (isDeepStrictEqual(oldValue, parsed)) {
  continue;  // 不写入 entries，不触发 publish 和事件
}
```

---

## 5. 边界条件清单

- [ ] `save()` 传入空对象 `{}` — 返回 0，无操作
- [ ] `save()` 传入 schema 中不存在的字段 — 跳过，不报错
- [ ] `save()` 中单个字段校验失败 — 整个操作 reject，`_value` 不变
- [ ] `save()` 中所有字段值与当前一致 — 返回 0，不写 Redis 不推送
- [ ] `save()` Redis 写入失败 — throw，`_value` 不变
- [ ] `initialize()` 时 Redis 无数据 — 使用 schema 默认值
- [ ] 多个字段同时变更 — 一轮 `save()` 中逐个 `publisher.update()` + `change:key` 事件
- [ ] Deep diff 检测嵌套对象变化 — 嵌套字段内容不变时跳过 publish

---

## 6. 依赖

- `@hile/micro` — 提供 `Application`、`app.publish`/`app.subscribe`
- `ioredis` — Redis 持久化
- `zod` — Schema 定义与校验
