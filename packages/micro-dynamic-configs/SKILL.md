---
name: micro-dynamic-configs
description: Code generation and contribution rules for @hile/micro-dynamic-configs. Use when editing this package or when the user asks about dynamic config patterns or API.
---

# @hile/micro-dynamic-configs

面向 AI 编码模型与维护者的代码生成规范。阅读后应能正确使用本库编写符合架构规则的代码。

---

## 1. 架构总览

三个角色，通过 `@hile/micro` 的 WebSocket 通信：

```
APP_3 (Publisher)          APP_1 (Config Server)         APP_2 (Subscriber)
    │                            │                              │
    │    save({ key: val })      │                              │
    ├──────────────────────────► │                              │
    │                            │   push /-/dynamic-configs/   │
    │                            │   change { key, newValue }   │
    │                            ├─────────────────────────────►│
    │                            │                              │
    │                            │◄── subscribe(fields) ───────┤
    │                            │───── initial values ────────►│
```

- **Config Server** (`MicroDynamicConfigsServer`) — 持有配置数据，管理订阅者列表，推送变更
- **Subscriber** (`MicroDynamicConfigClients`) — 订阅某个 namespace 的配置字段，接收实时推送
- **Publisher** — 调用 `server.save()` 修改配置，数据流向是：validate → Redis 持久化 → 内存更新 → 推送通知

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

// 从 Redis 加载持久化数据，返回 teardown 函数
initialize(): Promise<() => void>

// 持久化并推送变更
save(value: Partial<z.infer<Z>>): Promise<number>

// 当前配置快照（只读）
get value(): z.infer<Z>
```

### MicroDynamicConfigClients

```typescript
class MicroDynamicConfigClients

constructor(app: Application)

subscribe<T extends Record<string, any>>(
  namespace: string,
  fields: (keyof T)[]
): Promise<T>

close(): Promise<void>
```

### DynamicConfigClient (通常不直接使用)

```typescript
class DynamicConfigClient<T extends Record<string, any>>

getValue(): Promise<T>
close(): Promise<void>
setValue<K extends keyof T>(k: K, v: T[K]): this  // 由 push handler 调用
```

---

## 3. 通信协议

### 路由端点

| 方向 | 路径 | 数据 | 返回 |
|------|------|------|------|
| Subscriber → Server | `/-/dynamic-configs/subscribe` | `string[]` (字段名) | `Record<string, any>` (字段值) |
| Subscriber → Server | `/-/dynamic-configs/unsubscribe` | `string[]` (字段名) | `number` (timestamp) |
| Server → Subscriber | `/-/dynamic-configs/change` (push) | `{ key, newValue, oldValue, namespace }` | — |

### 订阅流程

1. 客户端通过 Registry 发现目标 namespace 的 `host:port`
2. 建立 WebSocket 连接
3. 发送 subscribe 请求，服务端注册并返回初始值
4. 服务端数据变更时，遍历 `stacks` 中该字段的订阅者，逐个 push
5. 客户端收到 push 后更新本地缓存

### 退订与断连

- 显式退订：调用 `close()` → 发送 unsubscribe 请求
- 被动断连：WebSocket close → 服务端 `onClientDisconnect` 清理所有 `stacks`
- 客户端断连后 `_status = 0`，下次 `getValue()` 重新走完整订阅流程

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
// Pass 2: persist → memory → emit
await redis.set(key, JSON.stringify(next));
update memory;
emit events;

// ✗ 禁止：validate 和 mutate 混在一轮
for (const key of keys) {
  this._value[key] = parsed;  // ❌ 后续字段失败时 _value 已脏
}
```

### 4.2 客户端状态机

```
_status: 0 (uninit) ──getValue()──→ 1 (loading)
    ↑                                    │
    │                           subscribe()
    │                              │
    │                         ┌────┴────┐
    │                    fail │         │ success
    │                    ┌────┘         └────┐
    │                    ↓                   ↓
    │                    0 (retry)           2 (ready)
    │                                        │
    │                            disconnect  │
    │                              ────────→ 0
    │                              close()
    └────────────────────────────────── closed
```

- `close()` 设 `_closed = true`，pending subscribe 完成时检测标记并 dispose 连接
- `close()` 后 `getValue()` 直接 reject

### 4.3 生命周期

```typescript
// 服务端初始化
const teardown = await server.initialize();
// ... 运行 ...
teardown(); // 清理所有监听器和订阅

// 客户端创建
const configs = new MicroDynamicConfigClients(app);
const value = await configs.subscribe("ns", ["key1"]);
// ... 使用 ...
await configs.close(); // 清理所有订阅连接
```

---

## 5. 反模式（禁止）

### 5.1 save() 中字段校验失败后保留脏状态

```typescript
// ✗
for (const key of keys) {
  this._value[key] = parsed;  // 后续失败 → 脏数据
}
await redis.set(...);

// ✓ 先全部校验，再统一写入
```

### 5.2 close() 前不检查 pending subscribe

```typescript
// ✗ close() 不设标记，pending subscribe 完成导致 client 复活
async close() {
  await this.unsubscribe();
  this._client = undefined;
}

// ✓ close() 先设 _closed 标记
async close() {
  this._closed = true;
  await this.unsubscribe();
  this._client = undefined;
}
```

### 5.3 多个 MicroDynamicConfigClients 实例共享同一 app

rou3 `dispatch()` 只执行第一个匹配的 handler，第二个实例的 `/-/dynamic-configs/change` 不会触发。一个 app 只应创建一个 `MicroDynamicConfigClients` 实例。

### 5.4 在 push handler 中做耗时的同步操作

push handler 在 message 调度线程中执行，不应包含耗时操作。`setValue()` 仅是内存写入，保持轻量。

---

## 6. 边界条件清单

- [ ] `save()` 传入空对象 `{}` — 返回 0，无操作
- [ ] `save()` 传入 schema 中不存在的字段 — 跳过，不报错
- [ ] `save()` 中单个字段校验失败 — 整个操作 reject，`_value` 不变
- [ ] `save()` 中所有字段值与当前一致 — 返回 0，不写 Redis 不推送
- [ ] `save()` Redis 写入失败 — throw，`_value` 不变
- [ ] `initialize()` 时 Redis 无数据 — 使用 schema 默认值
- [ ] `close()` 在 subscribe 完成前调用 — `_closed` 标记防止复活，新连接被 dispose
- [ ] `close()` 后调用 `getValue()` — 直接 reject
- [ ] 订阅不存在的字段 — 服务器静默跳过，不返回该字段
- [ ] 同一 namespace 重复 subscribe — 复用已有 client，`fields` 不会合并
- [ ] 断连后重新 subscribe — `_status = 0` → 全量重新拉取
- [ ] 服务端推送时订阅者已断连 — `has(client)` 检查跳过，等待 `onClientDisconnect` 清理
- [ ] 多个字段同时变更 — 一轮 `save()` 中多次 `change:key` 事件，订阅者逐个收到
