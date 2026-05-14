# @hile/micro

基于 `@hile/message-loader` 与 `@hile/message-ws` 的轻量级 **WebSocket 微服务框架**。提供服务注册与发现、心跳保活、熔断、请求超时、自动重试、调用链路追踪等功能。

## 架构分层

```
MessageLoader (路由) + MessageWs (请求/响应传输)
  └── Server（WebSocket 服务底层）
        ├── Registry（注册中心）
        └── Application（应用服务）
```

| 组件 | 职责 |
|------|------|
| **Server** | WebSocket 监听、连接管理、消息路由。不关心注册中心 |
| **Client** | 远端 Server 的代理，提供 `request()` / `push()` 通信接口 |
| **Registry** | 注册中心。维护 namespace → 实例列表，心跳检测剔除死实例 |
| **Application** | 应用服务。集成注册发现、熔断、重试、追踪等功能 |

一个 `Application` 实例 **同时** 扮演 provider（`register` 暴露接口）和 consumer（`get` / `call` 调用其它服务）。

## 安装

```bash
pnpm add @hile/micro
```

依赖：`@hile/message-loader`、`@hile/message-ws`、`ws`。

---

## 快速开始

### 1. 启动 Registry

```typescript
import { Registry } from '@hile/micro';

const registry = new Registry({ advertiseHost: '127.0.0.1' });
await registry.listen(9000);
```

### 2. 启动 Provider（服务 A）

以下 `provider` 和 `consumer` 是两个不同进程（不同 namespace），**每个进程只需要一个 `Application` 实例**，同时扮演 provider 和 consumer：

```typescript
import { Application } from '@hile/micro';

const provider = new Application({
  namespace: 'payments',
  registry: { host: '127.0.0.1', port: 9000 },
  advertiseHost: '127.0.0.1',
});

await provider.listen(9100);

provider.register('/charge', async ({ data }) => {
  return { charged: true, amount: data.amount };
});
```

### 3. 启动 Consumer 调用（服务 B）

```typescript
import { Application } from '@hile/micro';

const consumer = new Application({
  namespace: 'checkout',
  registry: { host: '127.0.0.1', port: 9000 },
  advertiseHost: '127.0.0.1',
});

await consumer.listen(9200);

// call() = get() + request() + response() + 熔断 + 重试
const result = await consumer.call('payments', '/charge', { amount: 100 });
console.log(result); // { charged: true, amount: 100 }
```

### 4. 关闭

`listen()` 返回的 teardown 函数关闭 WebSocketServer 并断开所有连接：

```typescript
const stop = await provider.listen(9100);
await stop();
```

---

## 核心功能

### 服务发现 (`get`)

按 namespace 从 Registry 获取一个远端 Client 并缓存：

```typescript
const client = await consumer.get('payments');
const { response } = client.request('/charge', { amount: 100 });
const result = await response();
```

- 首次查询通过 Registry `/-/find` 获取地址
- 结果**缓存**在内存中（namespace → Client）
- 当 Client 断连时自动清理缓存，下次 `get` 重新发现

### 熔断器 (Circuit Breaker)

`call()` 自动跟踪每个 namespace 下各 peer 的调用失败。失败的 peer 被临时排除，**30 秒冷卻期**后自动恢复。

| 场景 | 行为 |
|------|------|
| 调用 peer A 失败 | A 加入排除列表（30s cooldown） |
| 再次调用该 namespace | Registry `/‑/find` 带上 `exclude`，返回其他 peer |
| 所有 peer 都被排除 | 重置排除列表，重新从所有 peer 中选择 |
| 调用成功 | 该 peer 从排除列表中移除 |

排除列表：
- 键：`${host}:${port}`
- 存储：`Map<namespace, Map<peerKey, openedAt>>`
- 冷卻期：`CB_COOLDOWN_MS = 30_000`（30 秒）
- 过期检查：`getActiveExcludes()` 在每次 `call()` 调用时执行

### 请求超时

每个请求都有超时控制：

```typescript
// 构造时设置全局默认超时
const app = new Application({
  namespace: 'svc',
  registry: { host, port },
  requestTimeoutMs: 10_000,  // 默认 30000ms
});

// 单次调用覆盖
await app.call('svc', '/api', data, 5_000);   // 5s 超时
await app.call('svc', '/api', data, 1_000, 0); // 1s 超时, 不重试
```

超时触发时，底层 MessageModem 会向对端发送 **ABORT** 消息取消远程执行。

### 手动取消请求

使用 `get()` 拿到 Client 后，`request()` 返回的 `abort()` 可主动取消正在等待响应的请求：

```typescript
const client = await consumer.get('payments');
const { response, abort } = client.request('/charge', { amount: 100 });

// 例如 5 秒后主动取消
setTimeout(() => abort(), 5000);

try {
  const result = await response();
} catch (err) {
  // 超时或手动 abort 都会 reject
}
```

- `abort()` 向对端发送 **ABORT 消息**，让远程 handler 提前终止
- 超时到期内部也会调用 `controller.abort()`，机制相同
- 适用场景：用户取消、页面卸载、竞态淘汰

### 自动重试

`call()` 默认 retries=1，失败后自动换 peer 重试：

```typescript
await app.call('svc', '/api', data);        // 默认重试 1 次
await app.call('svc', '/api', data, 5000, 3); // 超时 5s, 重试 3 次
await app.call('svc', '/api', data, 5000, 0); // 超时 5s, 不重试
```

重试策略：失败 → `recordFailure`（peer 被排除）→ 递归 `call(retries-1)` → `getActiveExcludes` 排除已失败的 peer → Registry `/‑/find` 返回其他 peer。

### Correlation ID 链路追踪

`call()` 自动为每次调用注入唯一 `_correlationId`：

```typescript
provider.register('/api', async ({ data }) => {
  console.log(data._correlationId); // 自动注入的 UUID
});
```

行为规则：

| 入参 data | 结果 |
|-----------|------|
| `null / undefined` | 包装为 `{ _correlationId, data: null }` |
| 字符串 / 数字 | 包装为 `{ _correlationId, data: '原始值' }` |
| 数组 | 包装为 `{ _correlationId, data: [原始数组] }` |
| `{ value: 1 }` (无 `_correlationId`) | 扩展为 `{ value: 1, _correlationId: 'uuid' }` |
| `{ _correlationId: 'trace-1' }` | 保留已有 ID，**不覆盖** |

> **注意：** 原 data 对象不会被修改（使用浅拷贝 `{ ...data, _correlationId }`）。

### 健康检查

每个 `Application` 自动注册 `/-/health` 端点：

```typescript
// 通过 dispatch 调用（同进程内）
const health = await app.dispatch('/-/health', {});
// { status: 'ok', registry: true, uptime: 123.45, namespaces: ['payments'] }
```

返回字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `'ok'` | 固定值 |
| `registry` | `boolean` | 是否已连接 Registry |
| `uptime` | `number` | 进程启动时长（秒） |
| `namespaces` | `string[]` | 本地已缓存的 namespace 列表 |

### 缓存降级

当 Registry 不可用但本地仍有已缓存的 Client 连接时，`get()` 自动降级使用缓存：

| 场景 | 行为 |
|------|------|
| Registry 宕机 + 缓存有效 | 返回缓存 Client，继续服务 |
| Registry 宕机 + 缓存已过期 | 报错 |
| 全新 namespace + Registry 宕机 | 报错 |
| Registry 恢复 | 恢复正常查询 |

### Registry 心跳保活

- **Application** 每 10 秒向 Registry 推送 `/-/heartbeat`
- **Registry** 每 1 秒检查所有实例的心跳时间戳
- 超过 20 秒未收到心跳的实例被自动剔除并断开连接

### Registry 重连

当 Application 与 Registry 的连接断开时：
1. 立即尝试重连（`reconnectToRegistry`）
2. 若失败，3 秒后重试（`scheduleRegistryRetry`）
3. 若 `listen()` 返回的 teardown 已触发（`stopped = true`），停止重连

---

## 连接协议

### 连接 URL 格式

出站 WebSocket URL：

```
ws://{targetHost}:{targetPort}/{announceHost}/{listenPort}/{namespace}
```

- `announceHost`：构造时传入 `advertiseHost` 或自动获取的 IPv4
- `listenPort`：`listen(port)` 设置的端口
- `namespace`：构造时传入的 namespace 字符串

### 入站路径解析

`Server.onConnected` 将 URL 路径按 `/` 分割为：

```
[callerHost, callerPort, ...extras]
```

- `extras` 以 `/` 分段，Registry 用 `extras.join('/')` 作为 namespace

---

## API 参考

### ApplicationProps

```typescript
type ApplicationProps = {
  namespace: string;                           // 本服务 namespace
  registry: { host: string; port: number };    // Registry 地址
  registryLookupTimeoutMs?: number;            // /-/find 超时，默认 10000
  requestTimeoutMs?: number;                   // 单次请求超时，默认 30000
} & { advertiseHost?: string };                // 出站宣告地址
```

### Application

```typescript
class Application extends Server {
  constructor(props: ApplicationProps);

  // 启动监听，自动连接 Registry，启动心跳
  listen(port: number): Promise<() => Promise<void>>;

  // 获取 namespace 对应的远端 Client（缓存 + 自动发现）
  get(namespace: string, exclude?: string[]): Promise<Client>;

  // 一站式调用：get + request + response + 熔断 + 重试 + 追踪
  call<T = any>(
    namespace: string,
    url: string,
    data: any,
    timeout?: number,     // 请求超时（ms），默认 requestTimeoutMs
    retries?: number,     // 失败重试次数，默认 1
  ): Promise<T>;

  // 注册路由（provider 侧）
  register<T = any>(url: string, handler: (ctx) => Promise<T>): () => void;

  // 同进程调用路由
  dispatch(url: string, data: any): Promise<any>;
}
```

### Registry

```typescript
class Registry extends Server {
  constructor(props?: MicroServerProps);
  listen(port: number): Promise<() => Promise<void>>;
  onFind(): void; // 幂等地挂载 /-/find 路由
}
```

### Server

```typescript
class Server extends MessageLoader {
  constructor(namespace: string, props?: MicroServerProps);
  listen(port: number): Promise<() => Promise<void>>;
  setPort(port: number): this;
  // 以下方法受保护：
  protected connect(host: string, port: number, timeout?: number): Promise<Client>;
}
```

### Client

```typescript
class Client extends MessageWs {
  request(url: string, data: any, timeout?: number): { abort(): void; response<T>(): Promise<T> };
  push(url: string, data: any, timeout?: number): void;
  dispose(): void;
}
```

---

## 与 Hile core 的关系

`@hile/micro` 不依赖 `@hile/core`，可与任意 Node.js 进程或在未来由 `defineService` 包装后接入 Hile 容器。

---

## License

MIT
