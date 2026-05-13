---
name: micro
description: Code generation and contribution rules for @hile/micro. Use when editing this package or when the user asks about @hile/micro patterns or API.
---

# @hile/micro

本文档面向 **AI 编码模型** 与 **贡献者**：在修改或生成 `@hile/micro` 相关代码前必读，保证与现有 WebSocket 路由、注册中心与 `MessageLoader` 约定一致。

---

## 1. 架构总览

`@hile/micro` 在 `@hile/message-loader` + `@hile/message-ws` 之上提供 **轻量级进程间服务发现与会话**。分层理解：

- **`Server`**：实现服务的 **底层协议与运行时**——`WebSocketServer` + 路径约定；对内 `MessageLoader.register` / `dispatch` 完成 `{ url, data }` 路由。不包含注册中心逻辑。
- **`Registry`**：**注册中心**，固定 `namespace` 为 `'registry'`，维护「逻辑 namespace → 一组 `host:port`」；`/-/find` 在集合中 **随机** 返回一条地址（见 `selectRandomRegistryAddress`）。
- **`Application`**：**基于 `Server` 的应用侧实现**（`extends Server`）；`listen(port)` 后自动 `connect` 到注册中心；`get(targetNamespace)` 向注册中心查询并 **缓存** 到目标服务的 `Client`，目标断连后删除缓存以便下次重新发现。
- **`Client`**：连接到远端 `Server`，`request(url, data)` / `push(url, data)` 将负载交给本端 `Server.dispatch`；`dispose()` 会移除监听并 **关闭底层 WebSocket**，避免 `listen` 关闭阶段挂住。

**应用模型**：`Application = provider + consumer`——同一实例既可 `register(...)`（对外提供能力），也可 `get(ns)` 再 `request`/`push`（消费其它 namespace）。文档示例常拆成两个进程分别演示 provider / consumer，API 层面仍是同一个类。

依赖链：

```
MessageLoader (路由) + MessageWs (请求/响应传输)
  └── Server（底层协议）+ Client
        ├── Registry（注册中心，一种特殊的 Server 用法）
        └── Application（基于 Server，叠加上注册发现）
```

---

## 2. 路由与 URL 约定（强约束）

### 2.1 入站连接路径

对端发起连接时的 URL 必须为：

```text
ws://{listenHost}:{listenPort}/{callerHost}/{callerPort}/{...extras}
```

解析规则见 `Server.onConnected`：

- 至少 **三段** 路径：`callerHost`、`callerPort` 以及后续 `extras`（可为空）。
- `extras` 以 `/` 分段，在 `events.emit('connect', client, extras)` 中交给业务；**Registry** 用 `extras.join('/')` 作为 **服务逻辑 namespace**。

生成侧：`Server.connect()` 使用：

```text
ws://{host}:{port}/${this.ipv4}/${this.port}/${this.namespace}
```

其中 `this.ipv4` 来自 `getLocalIPv4()`（见 `utils.ts`），`this.port` 为当前 `listen` 端口，`this.namespace` 为构造传入的字符串（如 `provider`、`consumer`、`registry`）。

### 2.2 MessageLoader 路由

- 对内消息体为 `{ url, data }`，与 `Client.exec` 一致。
- `Registry` 注册：`register<RegistryFindData>('/-/find', handler)`，请求体 `{ namespace: string }`。

---

## 3. 类型与关键 API（生成代码须一致）

```typescript
// server.ts
export type MicroServerProps = MessageLoaderProps & {
  /** 出站 URL 宣告段；缺省 getLocalIPv4()，皆无则构造抛错 */
  advertiseHost?: string;
};

// registry.ts
export function parseAddressKey(key: string): RegistryAddress | undefined;

export function selectRandomRegistryAddress(
  keys: Iterable<string>,
): RegistryAddress | undefined;

export class Registry extends Server { /* constructor(props?: MicroServerProps); onFind() 幂等 */ }

// application.ts
export type ApplicationProps = {
  namespace: string;
  registry: RegistryAddress;
  /** 默认 10000；对 `/-/find` 的 response 等待上限 */
  registryLookupTimeoutMs?: number;
} & MicroServerProps;

export class Application extends Server {
  listen(port: number): Promise<() => Promise<void>>;
  get(namespace: string): Promise<Client>;
}

// server.ts — connect 第三参仅用于测试或内部，默认超时 5s
protected async connect(host: string, port: number, timeout?: number): Promise<Client>;

// client.ts
export class Client extends MessageWs {
  request(url: string, data: any, timeout?: number): ReturnType<MessageWs['_send']>;
  push(url: string, data: any, timeout?: number): void;
  dispose(): void;
}
```

`Application` 内部缓存查找状态为 `IDLE` → `PENDING` → `READY`：首次 `get` 必须从 `IDLE` 触发 `findFromRegistry`，禁止再出现「初始状态与触发条件不匹配」导致永久挂起。

---

## 4. 代码生成模板与规则

### 4.1 Registry 服务端

```typescript
const registry = new Registry({ advertiseHost: '127.0.0.1' });
const dispose = await registry.listen(registryPort);
// shutdown: await dispose();
```

### 4.2 可被发现的服务（Application）

```typescript
const app = new Application({
  namespace: 'my-service',
  registry: { host: '127.0.0.1', port: registryPort },
  advertiseHost: '127.0.0.1',
});
const dispose = await app.listen(appPort);

app.register('/hello', async ({ data }) => {
  return { ok: true, data };
});

const peer = await otherApp.get('my-service');
const { response } = peer.request('/hello', { x: 1 });
const result = await response();
```

### 4.2 连接超时

`Server.connect` 默认 **5 秒** 内未完成握手则 `reject(new Error('Connection timeout'))`。自定义第三参仅限受保护方法与测试辅助类，不要在公开 API 上强制调用方传入。

### 4.3 随机选择

`/-/find` 返回的地址必须来自 Registry 内存集合内的 `host:port` 键；新增选择策略时需保持 **Registry 端无额外状态机**（尽量无 cursor），除非你同时补充设计与测试。

---

## 5. 反模式（禁止）

- 修改 WebSocket URL 三段式约定却不同时更新 **`Server.onConnected`** 与 **`Server.connect`** 的拼接格式。
- 在 `Registry` 中按 `Set` **迭代顺序** 固定返回「第一个」实例（破坏负载分散）；除非你明确改需求并改写测试。
- `Client`/`Server` **`dispose`** 后不关闭 **`ws`**（会导致 **`WebSocketServer.close`** 长时间等待）；本包已在 `Client.dispose` 内关闭socket，不要随意删除。
- 假设 `host:port` 串可无损表达 **IPv6**：注册表 Set 的键应使用 **`[IPv6]:port`**；`selectRandomRegistryAddress` / `parseAddressKey` 按 **最后一个 `:`** 切分 host 与 port。
- `Application.props.registry` **不要传错端口**；丢失与注册中心的连接时依赖 `reconnectToRegistry`，不要在外部缓存 `registry` Client 绕过重连语义。

---

## 6. 测试与改动范围

- 包内测试：`packages/micro/src/index.test.ts`（Vitest）。
- 修改行为时至少覆盖：**随机选择 helper**、`Application` 端到端发现、**连接超时**。
- 发布前在项目根或通过 filter 运行：`pnpm --filter @hile/micro test` 与 `pnpm --filter @hile/micro build`。
