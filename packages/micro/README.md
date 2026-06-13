# @hile/micro

基于 `@hile/message-loader` 与 `@hile/message-ws` 的轻量级 **WebSocket 微服务框架**。提供服务注册与发现、心跳保活、熔断、请求超时、自动重试等功能。

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
| **Application** | 应用服务。集成注册发现、熔断、重试等功能 |

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
await app.call('svc', '/api', data, { timeout: 5_000 });          // 5s 超时, 默认重试 1 次
await app.call('svc', '/api', data, { timeout: 1_000, retries: 0 }); // 1s 超时, 不重试
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
await app.call('svc', '/api', data);                          // 默认重试 1 次
await app.call('svc', '/api', data, { timeout: 5000, retries: 3 }); // 超时 5s, 重试 3 次
await app.call('svc', '/api', data, { timeout: 5000, retries: 0 }); // 超时 5s, 不重试
```

重试策略：失败 → `recordFailure`（peer 被排除）→ 递归 `call(retries-1)` → `getActiveExcludes` 排除已失败的 peer → Registry `/‑/find` 返回其他 peer。

### 流式调用 (Stream)

`stream()` 用于**需要持续推送数据**的场景：大数据集、实时事件、LLM token 流、进度上报等。不需要流式传输时优先用 `call()`。

**Provider 侧**：消息处理器必须返回 async generator（`async function*`）。

```typescript
// 通过 register() 注册
app.register('/events', async function* () {
  for (let i = 0; i < 100; i++) {
    yield { seq: i, time: Date.now() }
    await new Promise(r => setTimeout(r, 100))
  }
})

// 或通过 .msg 文件定义（推荐）
// src/messages/events.msg.ts
import { defineMessage } from '@hile/message-loader'
export default defineMessage(async function* ({ data }) {
  for (const item of await fetchItems(data.query)) {
    yield item
  }
})
```

**Consumer 侧**：`app.stream()` 返回 `Readable` stream，可用 `for await` 逐 chunk 消费。

```typescript
const stream = await app.stream('data-svc', '/events', { query: 'recent' })
for await (const chunk of stream) {
  console.log(chunk)  // { seq: 0, time: 1718000000000 }
}
```

**注意事项**：
- 普通 handler（返回非 async iterable）被 `stream()` 调用时会报错 `"Invalid async iterable"`
- 不需要流式传输时用 `call()`，不要用 `stream()` 取单次返回值
- `stream()` 享有与 `call()` 相同的熔断、重试、超时机制

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

## 配置管理

### Registry 工作目录

Registry 启动时自动创建 `~/.registry/` 工作目录。YAML 配置文件存放在 `~/.registry/configs/` 下，按 namespace 分文件管理：

```
~/.registry/
  └── configs/
        ├── service-a.config.yaml
        ├── service-b.config.yaml
        └── global.config.yaml
```

### 配置文件热加载

Regsitry 监听 `configs/` 目录的文件变化，新增或修改 `*.config.yaml` 文件时自动加载（兼容 vim 原子写入），无需重启：

```bash
# 创建或修改 ~/.registry/configs/my-service.config.yaml
# Registry 自动检测变化并更新内存中的配置
```

### 远程读取配置

通过 `/-/env/variables` 端点，已连服务可按 namespace 和字段从 Registry 远程读取配置：

```typescript
// Application 侧
const result = await app.getEnvVariables(
  { namespace: 'service-a', fields: ['db.host', 'db.port'] },
  { namespace: 'global' },
);
// result = {
//   'service-a': { 'db.host': '10.0.0.2', 'db.port': 3306 },
//   'global': { featureFlag: true },
// }
```

---

## CLI

### `hile registry`

启动注册中心：

```bash
# 使用默认配置
hile registry

# 指定端口
hile registry --port 8888

# 指定宣告地址
hile registry --host 10.0.0.1
```

### `hile registry configs`

管理 `~/.registry/configs/` 下的 YAML 配置文件：

```bash
# 列出所有 namespace
hile registry configs

# 查看配置（YAML 输出）
hile registry configs get my-service

# 查看配置（JSON 输出）
hile registry configs get my-service --json

# 设置配置项
hile registry configs set my-service port=8080
hile registry configs set my-service debug=true

# 删除整个 namespace
hile registry configs del my-service

# 删除某个字段（需确认）
hile registry configs del my-service port

# 跳过确认删除
hile registry configs del my-service -y
```

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

  // 一站式调用：get + request + response + 熔断 + 重试
  call<T = any>(
    namespace: string,
    url: string,
    data: any,
    options?: {
      timeout?: number,     // 请求超时（ms），默认 requestTimeoutMs
      retries?: number,     // 失败重试次数，默认 1
      signal?: AbortSignal, // 手动取消
    },
  ): Promise<T>;

  // 流式调用：get + stream + 熔断 + 重试
  // provider handler 必须返回 async generator，consumer 获得 Readable stream
  stream(
    namespace: string,
    url: string,
    data: any,
    options?: {
      signal?: AbortSignal,
      retries?: number,     // 失败重试次数，默认 1
    },
  ): Promise<import('stream').Readable>;

  // 注册路由（provider 侧）
  register<T = any>(url: string, handler: (ctx) => Promise<T>): () => void;

  // 同进程调用路由
  dispatch(url: string, data: any): Promise<any>;

  // 远程读取 Registry 的配置（强类型）
  getEnvVariables<
    T extends Record<string, Record<string, any>>,
    const Requests extends readonly EnvRequest<T>[],
  >(...data: Requests): Promise<GetEnvVariablesResult<T, Requests>>;
}
```

### Registry

```typescript
class Registry extends Server {
  constructor(props?: MicroServerProps);
  listen(port: number): Promise<() => Promise<void>>;
  onFind(): void; // 幂等地挂载 /-/find 路由
  watchEnvFile(): fs.FSWatcher | undefined; // 监听 ~/.registry/configs/ 目录内的 *.config.yaml 文件变化
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
  stream(url: string, data: any, options?: { signal?: AbortSignal }): Readable;
  dispose(): void;
}
```

---

## 与 Hile core 的关系

`@hile/micro` 不依赖 `@hile/core`，可与任意 Node.js 进程或在未来由 `defineService` 包装后接入 Hile 容器。

---

## License

MIT
