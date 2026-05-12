# @hile/micro

基于 `@hile/message-loader` 与 `@hile/message-ws` 的轻量级 **WebSocket 服务注册与发现**：用固定格式的连接 URL 标识对端，`Registry` 按逻辑 namespace 记录实例，`Application` 从注册中心拉取地址并缓存到远端服务的会话。

## 概念分层

1. **`Server`**：实现「服务」的 **底层协议与运行时**——基于 `ws` 监听、按路径解析对端身份，对内用 `MessageLoader` 做 `{ url, data }` 路由；不关心注册中心，只负责连接语义与消息派发。
2. **`Registry`**：**注册中心**，维护「逻辑 namespace → 一组实例地址」，`/-/find` 随机返回其一。
3. **`Application`**：**基于 `Server` 的具体应用侧实现**——继承 `Server`，在 `listen` 后自动连上 `Registry`，用 `get(namespace)` 发现其它服务并缓存 `Client`。

同一进程里通常只建一个 `Application`，它 **同时** 扮演 **provider**（`register` 暴露接口）与 **consumer**（`get` + `request`/`push` 调用其它 namespace）；文档里把「提供方 / 调用方」拆开示例，是为了说明两种用法，而不是两类不同的类。

## 安装

```bash
pnpm add @hile/micro
```

依赖：`@hile/message-loader`、`@hile/message-ws`、`ws`（随 workspace 一并解析）。

---

## 能做什么？

| 组件 | 作用 |
|------|------|
| `Server` | **底层协议**：监听 WebSocket；解析路径中的调用方地址与可选分段；对内用 `register`/`dispatch` 处理 `{ url, data }` |
| `Client` | 连到远端 `Server`，`request`/`push` 走 `MessageModem`，`dispose()` 会关闭底层连接 |
| `Registry` | **注册中心**：固定 namespace `'registry'`；实例上线/下线更新 namespace→地址集合；`/-/find` **随机** 返回其中一个地址 |
| `Application` | **基于 `Server` 的应用实现**：启动后连接 Registry；`register` 侧即 provider、`get` 侧即 consumer；`get(ns)` 查询并 **缓存** 到目标服务的 `Client`，断连后清空缓存 |

连接串格式（出站）：

`ws://目标主机:端口/{本机广告IPv4}/{本机监听端口}/{本机namespace}`

其中广告 IPv4 由 `getLocalIPv4()` 取第一个非回环网卡地址；多网卡或容器环境可能需要后续版本支持显式 `advertiseHost`（当前未暴露）。

出站 `connect` 默认 **5 秒**握手超时，超时报错 `Connection timeout`。

---

## 快速示例

### 1. Registry

```typescript
import { Registry } from '@hile/micro';

const registry = new Registry();
await registry.listen(9000);
```

### 2. 服务提供方（被其它 Application 发现的进程）

```typescript
import { Application } from '@hile/micro';

const provider = new Application({
  namespace: 'payments',
  registry: { host: '127.0.0.1', port: 9000 },
});

await provider.listen(9100);

provider.register('/charge', async ({ data }) => {
  return { charged: true, amount: data.amount };
});
```

### 3. 调用方（通过 Registry 解析地址）

```typescript
import { Application } from '@hile/micro';

const consumer = new Application({
  namespace: 'checkout',
  registry: { host: '127.0.0.1', port: 9000 },
});

await consumer.listen(9200);

const remote = await consumer.get('payments');
const { response } = remote.request('/charge', { amount: 100 });
const result = await response<{ charged: boolean; amount: number }>();
console.log(result);
```

### 关闭

`listen` 返回的 teardown 函数会关闭 WebSocketServer 并对已有 `Client` 调用 `dispose()`：

```typescript
const stop = await provider.listen(9100);
// ...
await stop();
```

---

## 与 Hile core 的关系

`@hile/micro` **不依赖** `@hile/core`，可与任意 Node.js 进程或在未来由 `defineService` 包装后接入 Hile 容器。

---

## 文档策略

| 文档 | 读者 | 用途 |
|------|------|------|
| 本 README | 使用者 | 安装、概念、示例 |
| `SKILL.md` | AI / 贡献者 | 路由约定、类型、反模式、测试门禁 |

仓库线上文档见 Mintlify：**API 参考 → @hile/micro**（若已启用）。

---

## License

MIT
