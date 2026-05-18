---
name: micro
description: Code generation and contribution rules for @hile/micro. Use when editing this package or when the user asks about @hile/micro API, types, patterns, or features.
---

# @hile/micro — AI Skill Reference

本文档面向 **AI 编码模型**。在生成或修改 `@hile/micro` 代码前必读，保证与现有架构、API 约定、状态机、测试模式一致。

---

## 1. 架构总览

### 依赖链

```
@hile/message-loader (路由: register/dispatch)
  └── @hile/message-ws (WebSocket 请求/响应, MessageModem timeout/abort)
        └── packages/micro
              ├── Server   — WebSocket 监听 + 连接管理 + Client 生命周期
              ├── Client   — 远端代理, request/push/dispose
              ├── Registry — 注册中心 (extends Server)
              └── Application — 应用服务 (extends Server)
```

### 分层职责

| 类 | 文件 | 职责 | 关键约束 |
|----|------|------|---------|
| `Server` | `server.ts` | WebSocketServer 生命周期, 出入站连接, Client Map | 不感知 Registry |
| `Client` | `client.ts` | 远端 Server 的 WebSocket 会话代理 | `dispose()` 必须关闭底层 socket |
| `Registry` | `registry.ts` | namespace → Set\<host:port\>, 心跳检测, /-/find 随机返回, 环境变量管理 | 自动创建 `~/.registry/` 工作目录 |
| `Application` | `application.ts` | 注册发现 + 熔断 + 重试 + 心跳 + 远程环境变量读取 | `listen()` 后自动连 Registry |

### 应用模型

一个 `Application` 实例同时是 provider 和 consumer。不要创建两个类来区分角色。

```
Application:
  └─ register(url, handler)   → provider 侧
  └─ get(namespace)           → consumer 侧, 返回 Client
  └─ call(namespace, url, data) → consumer 侧, get+request+熔断+重试 一站式
```

---

## 2. 类型定义（代码生成时必须一致）

### Server (`server.ts`)

```typescript
export type MicroServerProps = MessageLoaderProps & {
  advertiseHost?: string;  // 缺省 getLocalIPv4(), 皆无则构造抛错
};

export class Server extends MessageLoader {
  protected readonly clients = new Map<string, Client>(); // key: "host:port"
  public readonly events = new EventEmitter(); // connect/disconnect

  constructor(namespace: string, props?: MicroServerProps);
  public listen(port: number): Promise<() => Promise<void>>; // 返回 teardown
  public setPort(port: number): this;
  protected connect(host: string, port: number, timeout?: number): Promise<Client>;
  // 继承自 MessageLoader:
  // register<T, E>(url, handler): () => void;
  // dispatch(url, data, extras): Promise<any>;
}
```

### Client (`client.ts`)

```typescript
export class Client extends MessageWs {
  public readonly host: string;
  public readonly port: number;
  public readonly events = new EventEmitter(); // connect/disconnect

  request(url: string, data: any, timeout?: number): {
    abort(): void;
    response<T = any>(): Promise<T>;  // 超时或 abort 时 reject
  };
  push(url: string, data: any, timeout?: number): void;
  dispose(): void;  // 关闭底层 WebSocket
}
```

### Registry (`registry.ts`)

```typescript
export interface RegistryFindData {
  namespace: string;
  exclude?: string[];
}

export function parseAddressKey(key: string): RegistryAddress | undefined;
export function selectRandomRegistryAddress(keys: Iterable<string>): RegistryAddress | undefined;
// 配置文件路径工具：
export function getRegistryConfigsDir(): string;         // 返回 ~/.registry/configs/
export function namespaceToConfigFile(ns: string): string;  // 返回 ~/.registry/configs/{ns}.config.yaml
export function parseConfigFilename(filename: string): string | null;  // 解析 ".config.yaml" 后缀，提取 namespace

export class Registry extends Server {
  // heartbeat 常量:
  //   HEARTBEAT_INTERVAL = 1000   (1s 轮询)
  //   HEARTBEAT_TIMEOUT = 20000   (20s 未收到心跳则剔除)
  // 工作目录: ~/.registry/ (自动创建)
  //   - configs/ 目录存放 *.config.yaml 配置文件
  //   - watchEnvFile() 监听 configs/ 目录，兼容 vim 原子写入
  //   - configs Map<string, any> 按 namespace 存储解析后的 YAML 内容
  // 内部路由:
  //   /-/find             — 按 namespace 随机返回地址 (支持 exclude)
  //   /-/heartbeat        — 更新实例心跳时间戳
  //   /-/env/variables    — 按 namespace + fields 返回配置 (通过 getEnvVariables 调用)

  constructor(props?: MicroServerProps);
  listen(port: number): Promise<() => Promise<void>>;
  onFind(): void; // 幂等，可重复调用
  watchEnvFile(): fs.FSWatcher | undefined; // 监听 ~/.registry/configs/ 目录
}
```

### Application (`application.ts`)

```typescript
export type ApplicationProps = {
  namespace: string;
  registry: RegistryAddress;
  registryLookupTimeoutMs?: number; // /-/find 超时, 默认 10_000
  requestTimeoutMs?: number;        // 单次请求超时, 默认 30_000
} & MicroServerProps;

export class Application extends Server {
  // 内部常量:
  //   HEARTBEAT_INTERVAL = 10000   (10s 向 Registry 推送心跳)
  //   CB_COOLDOWN_MS = 30000      (熔断冷卻期 30s)
  // 内部状态:
  //   namespaces: Map<ns, { host, port, status: IDLE|PENDING|READY, handlers }>
  //   circuitBreakers: Map<ns, Map<peerKey, openedAt>>

  constructor(props: ApplicationProps);
  listen(port: number): Promise<() => Promise<void>>; // 自动连 Registry + 启心跳

  get(namespace: string, exclude?: string[]): Promise<Client>;
  // call() = get + request + response + 熔断 + 重试 + 超时
  call<T = any>(
    namespace: string,
    url: string,
    data: any,
    timeout?: number,     // 单次超时, 默认 requestTimeoutMs
    retries?: number,     // 重试次数, 默认 1
  ): Promise<T>;

  // 远程读取 Registry 的配置（强类型，按 namespace + fields）
  getEnvVariables<
    T extends Record<string, Record<string, any>>,
    const Requests extends readonly EnvRequest<T>[],
  >(...data: Requests): Promise<GetEnvVariablesResult<T, Requests>>;

  // 继承自 Server/MessageLoader:
  // register<T, E>(url, handler): () => void;
  // dispatch(url, data, extras): Promise<any>;
}
```

---

## 3. 功能详解（含状态机与逻辑流）

### 3.1 服务发现 `get(namespace, exclude?)`

```
get(ns, exclude?)
  ├─ namespaces 无此 ns → 创建 IDLE 条目
  ├─ status=READY + (client 已断连 or peer 被 exclude)
  │     └─ 重置为 IDLE, 清空 host/port
  ├─ status=READY + client 有效 + 未被 exclude
  │     └─ 直接返回缓存 Client (快路径)
  └─ 否则:
        └─ 新建 Promise, handler 入队
        └─ status=IDLE → PENDING → findFromRegistry(ns, exclude)
              ├─ Registry 返回地址 → connect → status=READY
              │     └─ 注册 disconnect → 清理 namespace 缓存
              │     └─ resolve 所有 handler
              └─ Registry 失败 or 无数据 →
                    └─ catch: 检查旧缓存 (cachedHost/cachedPort)
                          ├─ 缓存有效 → 降级: restore status=READY, resolve
                          └─ 无缓存 → delete namespace, reject 所有 handler
                    └─ finally: handlers.clear()
```

**关键点：**
- `cachedHost` / `cachedPort` 在缓存失效前保存，用于降级路径
- 降级时恢复 `stack.host/port/status=READY`，使后续调用走快路径
- 多并发 `get()` 共享同一个 Promise，handler 入队后统一 resolve/reject

### 3.2 熔断器 (Circuit Breaker)

**数据结构：** `Map<namespace, Map<peerKey, openedAt>>`

```
call() 失败:
  recordFailure(ns, host, port)
    → excludes.set("host:port", Date.now())

call() 成功:
  recordSuccess(ns, host, port)
    → excludes.delete("host:port")

getActiveExcludes(ns):
  → 遍历 excludes, 移除 Date.now() - openedAt >= 30000 的过期条目
  → 返回活跃的 exclude key 数组
```

**生命周期：**

```
peer 首次失败
  → circuitBreakers: { svc: { "127.0.0.1:8080": now } }
  → getActiveExcludes("svc") → ["127.0.0.1:8080"]
  → next call() 的 get() 带上 exclude, 排除该 peer
  → Registry 返回其他 peer (有则) 或 undefined (无则)
  → 如果所有 peer 都被排除, catch 块 delete circuitBreakers, 无 exclude 重试
=> "全排除 → 重置" 策略: 当 Registry 找不到未被排除的 peer, 熔断器清空, 从不安全全量重试
```

**冷卻期:** `CB_COOLDOWN_MS = 30000` (30 秒)。到期后 `getActiveExcludes` 自动清除旧条目。

### 3.3 请求超时

**配置链：**

```
ApplicationProps.requestTimeoutMs (default 30_000)
  → call(timeout?)  // 可选 override
    → client.request(url, data, timeout ?? this._requestTimeoutMs)
      → MessageModem._send({ url, data }, timeout)
        → MessageModem._write(data, timeout, twoway=true)
          → setTimeout(reject, timeout)
          → 超时: 发送 ABORT 消息 → 对端取消执行
```

- 超时默认 30 秒（MessageModem 默认值）
- 超时触发时向对端发送 **ABORT** 消息（不是仅仅本地 reject）
- 支持每个调用单独覆盖

### 3.5 手动取消（abort）

`client.request()` 返回的 `abort()` 函数可主动取消请求，**与超时共享同一套 ABORT 机制**：

```typescript
const client = await app.get('svc');
const { response, abort } = client.request('/api', data);

// 主动取消
abort();
await response(); // → reject (AbortException)

// 典型场景：竞态淘汰
const req = client.request('/slow', data);
// 如果其他条件满足，提前取消
if (cached) abort();
```

**实现原理：**
- `request()` 内部通过 `MessageModem._write()` 创建 `AbortController`
- `abort()` 调用 `controller.abort()` 触发 ABORT 消息发送
- 超时到期也调用同一个 `controller.abort()`，机制完全相同
- 区别仅在于触发源头：手动调用 vs 定时器到期

**适用场景：** 用户取消操作、页面/组件卸载、竞态条件（先发请求后发先至时取消旧请求）

```typescript
call(ns, url, data, timeout, retries = 1):
  get(ns, exclude) → client
  try:
    client.request(url, data, timeout) → response() → result
    recordSuccess(ns, host, port)
    return result
  catch err:
    recordFailure(ns, host, port)
    if retries > 0:
      return call(ns, url, data, timeout, retries - 1) // 递归
    throw err
```

**重试语义：**
- 首次失败 → peer 被排除
- 递归 `call(retries-1)` → `getActiveExcludes` 包含已失败的 peer
- `get()` 带上 exclude → Registry 返回其他 peer
- 所有 peer 都失败 → 熔断全排除 → catch 块重置 → 无 exclude 重试
- 每个 retry 共享同一个 timeout 值（不会延长总时间）

### 3.6 健康检查

在 `Application` 构造函数中注册：

```typescript
this.register('/-/health', async () => ({
  status: 'ok' as const,
  registry: !!this.registry,      // 是否连上 Registry
  uptime: process.uptime(),        // 进程运行秒数
  namespaces: [...this.namespaces.keys()],  // 已缓存的 namespace
}));
```

只在 Application 上注册，Server 和 Registry 没有。

### 3.7 Registry 心跳

```
Application (10s 间隔):
  startHeartbeat():
    setInterval(10000):
      registry.push('/-/heartbeat', {})

Registry (1s 间隔检查, 20s 超时):
  构造函数:
    events.on('connect', ...) → heartbeats.set(key, Date.now())
    register('/-/heartbeat', ...) → heartbeats.set(key, Date.now())
  listen():
    setInterval(1000):
      for each heartbeat entry:
        if now - lastTime >= 20000:
          clients.get(key).dispose()  // 剔除死实例
```

### 3.8 Registry 重连

```
listen():
  reconnectToRegistry() → connect + events.on('disconnect')

disconnect 触发:
  registry = undefined
  reconnectToRegistry():
    ├─ 成功 → 恢复正常
    └─ 失败 → scheduleRegistryRetry():
          └─ setTimeout(3000) → reconnectToRegistry()
               └─ 失败 → scheduleRegistryRetry() (循环)

listen() teardown 触发:
  stopped = true → 停止所有重连尝试
```

### 3.9 缓存降级

**触发条件：** `get()` 的 registry lookup 失败，但 `this.clients` 中仍然有之前缓存的 Client（WebSocket 未断开）。

**处理流程：**
1. `cachedHost` / `cachedPort` 在缓存失效前保存
2. Registry lookup 失败 → catch 块
3. `cachedHost && this.clients.has(cachedKey)` → 有效缓存
4. 恢复 `stack.host/port/status=READY`，resolve 所有 handler
5. 后续 `get()` 命中快路径，直接返回该 Client

**不处理的情况：** 全新 namespace（无缓存）、缓存 Client 已断连。

### 3.10 配置管理

**存储结构：**

```
~/.registry/
  └── configs/
        ├── service-a.config.yaml
        ├── service-b.config.yaml
        └── global.config.yaml
```

**Registry 侧：**

```
Registry 构造:
  1. 创建 ~/.registry/ 目录 (自动)

Registry listen():
  1. 调用 watchEnvFile()
     └─ 读取 ~/.registry/configs/ 下所有 *.config.yaml → YAML.parse
     └─ 按 namespace 存入 this.configs Map
     └─ 监听 configs/ 目录 (兼容 vim 原子写入)
         └─ 文件变化 → 重新 YAML.parse 并更新 this.configs

/-/env/variables 端点:
  register('/-/env/variables', async ({ data }) => {
    data.map(({ namespace, fields }) => {
      if (!this.configs.has(namespace))
        return { namespace, value: null }
      if (!fields?.length)
        return { namespace, value: this.configs.get(namespace) }
      // 按 fields 过滤
      return { namespace, value: filteredConfig }
    })
  })
```

**Application 侧：**

```typescript
// 强类型查询
type EnvRequest<T> = {
  [N in keyof T]: { namespace: N; fields?: readonly (keyof T[N])[] };
}[keyof T];

type GetEnvVariablesResult<T, Requests> = UnionToIntersection<...>;

getEnvVariables(...data: EnvRequest<T>[]): Promise<GetEnvVariablesResult<T, Requests>>
```

**CLI 管理配置：**

通过 `hile registry configs` 子命令直接管理 `~/.registry/configs/` 下的 YAML 文件：

```
hile registry configs                              # 列出所有 namespace
hile registry configs get <namespace>               # 查看配置（YAML/--json）
hile registry configs set <namespace> <key>=<value> # 设置配置项
hile registry configs del <namespace> [key]         # 删除（带确认，-y 跳过）
```

- CLI 直接读写 YAML 文件，运行中的 Registry 通过 `fs.watch` 自动感知
- 值类型自动推断：`true/false` → boolean, `null` → null, 纯数字 → number, 以 `{`/`[` 开头 → JSON 解析为 object/array, 其余 → string
- 实现代码在 `packages/cli/src/configs.ts`，工具函数在 `packages/micro/src/registry.ts`

---

## 4. 代码生成模板

### 4.1 三节点测试拓扑（所有 test 必须使用）

```typescript
const registryPort = await getAvailablePort();
const providerPort = await getAvailablePort();
const consumerPort = await getAvailablePort();

const registry = new Registry(testAdvertise);
const provider = new Application({
  namespace: 'svc',
  registry: { host: '127.0.0.1', port: registryPort },
  ...testAdvertise,
});
const consumer = new Application({
  namespace: 'consumer',
  registry: { host: '127.0.0.1', port: registryPort },
  ...testAdvertise,
});

const disposeRegistry = await registry.listen(registryPort);
const disposeProvider = await provider.listen(providerPort);
const disposeConsumer = await consumer.listen(consumerPort);
const unregister = provider.register('/echo', async ({ data }) => {
  return { value: data.value };
});

try {
  // ... test logic ...
} finally {
  unregister();
  await disposeConsumer();
  await disposeProvider();
  await disposeRegistry();
}
```

### 4.2 call() 的 timeout + retries 参数顺序

```typescript
// signature: call(ns, url, data, timeout?, retries?)
await app.call('svc', '/api', data);              // 默认超时 + 1 次重试
await app.call('svc', '/api', data, 5000);          // 5s 超时 + 1 次重试
await app.call('svc', '/api', data, 5000, 0);       // 5s 超时 + 不重试
await app.call('svc', '/api', data, undefined, 0);  // 默认超时 + 不重试
```

### 4.3 超时测试 Handler

```typescript
// handler 延迟 500ms, call 超时 50ms → 应 reject
provider.register('/slow', async () => {
  await new Promise(resolve => setTimeout(resolve, 500));
  return { value: 'too-late' };
});
await expect(consumer.call('svc', '/slow', {}, 50, 0)).rejects.toThrow('Abort');
```

### 4.4 熔断测试模板

```typescript
// 两个 provider 同 namespace, 一个失败, 排除后应选另一个
// 见 circuit breaker test "excludes a failing peer and selects a different one"

// 单个 peer 全排除后应重置并重试该 peer
// 见 circuit breaker test "resets breaker when all peers are excluded"
```

### 4.5 缓存降级测试模板

```typescript
// 1. 首次 call → 建立缓存
// 2. 切换为失败 handler → call 失败 → peer 被排除
// 3. 切回成功 handler → call 带 exclude → Registry find 返回 undefined
// 4. catch 块降级 → 返回缓存 Client → 请求成功
```

---

## 5. 测试门禁（修改时必须遵守）

### 5.1 运行命令

```bash
pnpm --filter @hile/micro build    # 必须通过
pnpm --filter @hile/micro test     # 必须全部通过
```

### 5.2 测试覆盖要求

修改行为时至少覆盖：

| 场景 | 测试位置 |
|------|----------|
| 服务发现端到端 | `application discovery > resolves a provider through the registry` |
| listen teardown 后可重新 listen | `application discovery > allows listen again after teardown` |
| Registry 不可达时 listen 回滚 | `application discovery > rolls back listen when registry is unreachable` |
| 心跳保活 | `heartbeat > keeps client alive when heartbeats arrive on time` |
| 心跳超时剔除 | `heartbeat > disconnects client that stops sending heartbeats` |
| call() 基本调用 | `circuit breaker > call() returns data on success` |
| 熔断排除 | `circuit breaker > excludes a failing peer and selects a different one` |
| 全排除重置 | `circuit breaker > resets breaker when all peers are excluded` |
| 健康检查 | `health endpoint > /-/health returns status and registry state` |
| 超时 reject | `request timeout > rejects when request exceeds the timeout` |
| 超时充足则成功 | `request timeout > succeeds when timeout is long enough` |
| 缓存降级 | `cache degradation > uses cached client when registry lookup fails due to exclusion` |
| YAML 配置加载 | `config file loading > loads yaml config files on watchEnvFile` |
| YAML 配置热加载 | `config file loading > reloads config when yaml file changes` |
| configs 目录不存在 | `config file loading > does not crash when configs directory does not exist` |
| /-/env/variables 按字段过滤 | `/-/env/variables endpoint > returns requested config by namespace and fields` |
| /-/env/variables 全字段 | `/-/env/variables endpoint > returns all config when fields not specified` |
| 不存在的 namespace | `/-/env/variables endpoint > returns null value for non-existent namespace` |
| /-/env/variables 空列表 | `/-/env/variables endpoint > handles empty data list` |
| getEnvVariables 集成 | `Application.getEnvVariables > fetches config from Registry` |
| getEnvVariables 不存在 namespace | `Application.getEnvVariables > returns null when namespace config does not exist` |
| getRegistryConfigsDir | `config file utilities > getRegistryConfigsDir returns path ending with .registry/configs` |
| namespaceToConfigFile | `config file utilities > namespaceToConfigFile returns path with .config.yaml suffix` |
| parseConfigFilename 正例 | `config file utilities > parseConfigFilename extracts namespace from valid filename` |
| parseConfigFilename 反例 | `config file utilities > parseConfigFilename returns null for non-config file` |

### 5.3 测试规范（必须遵守）

- 端口必须使用 `getAvailablePort()` 获取
- 所有清理必须放在 `finally` 块中
- 清理顺序：`unregister()` → `disposeConsumer` → `disposeProvider` → `disposeRegistry`
- 禁止使用真实定时等待代替事件驱动（心跳测试是唯一例外，因其依赖实时时钟）
- 禁止 mock `Application`、`Registry`、`Server`、`Client` 的内部方法
- 禁止共享可变状态（每个测试独立端口）

---

## 6. 反模式（禁止）

1. **不要修改 WebSocket URL 三段式约定**不同时更新 `Server.onConnected` 和 `Server.connect` 的拼接格式
2. **不要在 Registry 中按 Set 迭代顺序固定返回第一个**（破坏负载分散）
3. **不要在 `Client.dispose()` 中删除 `socket.close()`**（会导致 WebSocketServer.close 长时间等待）
4. **不要假设 `host:port` 可无损表达 IPv6** — 使用 `[IPv6]:port` 格式，`parseAddressKey` 按最后一个 `:` 切分
5. **不要传错 Registry 端口** — 丢失 Registry 连接时依赖 `reconnectToRegistry`，不要在外部缓存 registry Client
6. **不要在其他文件中重复 Registry 的 helper 函数** — `selectRandomRegistryAddress`、`parseAddressKey`、`getRegistryConfigsDir`、`namespaceToConfigFile`、`parseConfigFilename` 都在 `registry.ts` 中导出复用
7. **不要给 call() 增加非可选参数** — `timeout` 和 `retries` 都在尾部且保持可选，不影响现有调用

---

## 7. 文件改动范围

| 文件 | 可修改 | 说明 |
|------|--------|------|
| `packages/micro/src/application.ts` | ✅ | 核心业务逻辑 |
| `packages/micro/src/index.test.ts` | ✅ | 测试（主测试文件） |
| `packages/micro/src/env-config.test.ts` | ✅ | 测试（环境变量配置测试） |
| `packages/micro/src/server.ts` | ❌ | 底层协议，不动 |
| `packages/micro/src/client.ts` | ❌ | 底层协议，不动 |
| `packages/micro/src/registry.ts` | ✅ | 注册中心（配置管理、路径工具函数） |
| `packages/micro/src/utils.ts` | ❌ | 工具函数，不动 |
| `packages/micro/README.md` | ✅ | 用户文档 |
| `packages/micro/SKILL.md` | ✅ | AI 参考文档 |
| `packages/cli/src/index.ts` | ✅ | CLI 入口（registry configs 子命令组） |
| `packages/cli/src/configs.ts` | ✅ | CLI 配置管理 handler（list/get/set/del） |
| `packages/cli/src/start.ts` | ❌ | 启动逻辑，不动 |
| `packages/cli/src/exitHook.ts` | ❌ | 退出钩子，不动 |

---

## 8. 参考文件

| 文件 | 用途 |
|------|------|
| `packages/micro/src/registry.ts` | 注册中心（含配置管理、路径工具函数） |
| `packages/micro/src/application.ts` | 应用服务（含 getEnvVariables） |
| `packages/micro/src/index.test.ts` | 主测试文件（27 个用例） |
| `packages/micro/src/env-config.test.ts` | 配置管理测试文件（13 个用例） |
| `packages/cli/src/index.ts` | CLI 入口（含 registry configs 子命令组） |
| `packages/cli/src/configs.ts` | CLI 配置管理 handler（list/get/set/del） |
