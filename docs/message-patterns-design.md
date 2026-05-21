# @hile/micro 消息模式扩展设计

> 本文档讨论在现有 @hile/micro + message-* 体系上扩展消息模式的设计思路，
> 包含 Pub/Sub、流式响应、Scatter/Gather、Request/Acknowledge 四种模式。

---

## 目录

1. [现状回顾](#1-现状回顾)
2. [Pub/Sub（发布/订阅）](#2-pubsub发布订阅)
3. [流式响应（Streaming）](#3-流式响应streaming)
4. [Scatter/Gather（扇出聚合）](#4-scattergather扇出聚合)
5. [Request/Acknowledge（请求+确认）](#5-requestacknowledge请求确认)
6. [各模式改造成本一览](#6-各模式改造成本一览)
7. [推荐实施顺序](#7-推荐实施顺序)

---

## 1. 现状回顾

### 现有协议（message-modem）

底层消息协议定义了三种消息类型：

```
REQUEST   → 请求消息（可以带 twoway=true 或 false）
RESPONSE  → 响应消息（回复 REQUEST）
ABORT     → 取消消息（客户端主动取消等待中的请求）
```

两种通信模式：

| 方式 | 对应方法 | 行为 |
|------|----------|------|
| **request/response** | `_send()` (twoway=true) | 发送方阻塞等待响应，超时会抛错 |
| **fire-and-forget** | `_push()` (twoway=false) | 发送方不关心响应，发完即走 |

消息通过 `id` 字段关联请求和响应，靠 `this.stacks` Map 缓存等待中的回调。

### 现有服务层（micro）

各层的职责：

```
message-modem       基础协议（REQUEST/RESPONSE/ABORT）
      ↑
message-ws          WebSocket 传输层（JSON 序列化/反序列化）
      ↑
Server              消息路由 + 连接管理（clients Map）
      ↑
Application         服务发现（Registry） + 熔断 + 重试
Registry            服务注册中心（namespace → Set<peer>）
Client              对等连接封装（心跳 + request/push）
```

### 关键限制

当前的 `exec()` 签名：`protected abstract exec(data: any): Promise<any>`

- 一个请求 **只能得到一个响应**
- handler **无法主动与调用方交互**（没有 context 参数）
- 服务之间只能 **一对一** 通信
- 所有消息都是 **同步阻塞** 的

---

## 2. Pub/Sub（发布/订阅）

### 2.1 要解决的问题

"服务 A 发生了某件事，想让所有关心这件事的服务都知道"。

典型场景：
- 用户注册 → 通知服务 + 积分服务 + 日志服务 都收到事件
- 配置变更 → 所有依赖该配置的服务收到更新
- 服务上下线 → 通知所有依赖方

### 2.2 现状：怎么做？

现在只能手动遍历 Client 逐个 `push()`，没有任何订阅/发布语义：

```ts
// 伪代码：手动广播
for (const [, client] of this.clients) {
  client.push('/event/user-created', { userId: 123 });
}
```

问题：
- 调用方知道要发给谁，而不是"谁订阅了"
- 新加一个订阅者需要改发布方代码
- 断连后不会自动清理

### 2.3 核心问题：多实例隔离

Pub/Sub 的设计有一个绕不开的问题——**多实例场景下的订阅隔离**。

假设有三个服务：

```
Order Service (2 个实例)         Notification Service (1 个实例)
┌─────────────────────┐         ┌──────────────────────┐
│ App Instance A      │         │ App Instance C       │
│  subscribe("order_  │ ─────── │  listen              │
│   created")         │         │                      │
└─────────────────────┘         └──────────────────────┘
┌─────────────────────┐
│ App Instance B      │
│  (不知道 C 订阅了)   │
│  publish("order_    │
│   created")         │
└─────────────────────┘
```

如果 pub/sub 实现是**本地模式**（每个 Server 自己维护 topics 表），那么：
- 实例 B publish 时，只查自己的本地 topics 表
- 实例 B 的 topics 表里没有 C（C 连在 A 上）
- **C 收不到事件**

这就是"我订阅了，但发布方不知道我存在"的根源——**订阅信息不在一个共享的地方**。

### 2.4 设计方案

有三个方向可以解决：

| 方案 | 谁管订阅 | 谁转发消息 | 特点 |
|------|---------|-----------|------|
| **A：本地** | 各 Server 自己 | 发布方直推 | 简单但多实例无效 |
| **B：Registry 中转** | Registry | Registry | 全局有效，但多一跳延迟 |
| **C：Registry 管订阅，发布方直推** | Registry | 发布方直推 | 全局有效，无中转延迟 ✅ |

#### 方案 A：本地模式（只适合单实例场景）

在 Server 上维护一份 topic → Set<Client> 的映射。实现最简单，但**只对直连到同一个 Server 的 peer 生效**。

```
Server 内部：
topics: Map<topic, Set<Client>>
    ↓                 ↓
  "order.created"    [Client A, Client B]   ← 只包括直连的 peer
```

**优点：** 代码量最小，不需要改协议，不需要依赖 Registry
**缺点：** 多实例时订阅信息互相不可见，无法跨实例 pub/sub
**适用场景：** 单进程内的模块间通信、调试、demo

#### 方案 B：Registry 中转模式（全局事件总线）

Registry 维护 topic 订阅，也负责消息转发。publish 发给 Registry，Registry 再扇出给所有订阅者。

```
┌──────────┐  subscribe("orders")  ┌──────────┐
│  App A   │ ──────────────────→  │ Registry │
│          │                      │          │
│  App B   │  subscribe("orders") │ topics:  │
│          │ ──────────────────→  │ orders → │
│          │                      │ {A, B}   │
│  App C   │  publish("orders")   │          │
│          │ ──────────────────→  │ ──→ A    │
└──────────┘                      │ ──→ B    │
                                  └──────────┘
```

**优点：** 全局统一，订阅一致，断连自动清理
**缺点：** 所有消息经过 Registry 中转，多一跳延迟，大流量时 Registry 成为瓶颈

#### 方案 C：混合模式（Registry 管订阅，发布方直推）✅ 推荐

Registry 作为订阅信息的中心存储（只存元数据，不转发消息），发布方自己负责推送给所有订阅者。

```
  subscribe("orders")         subscribe("orders")
┌─────────┐                  ┌─────────┐
│  App A  │                  │  App B  │
└────┬────┘                  └────┬────┘
     │                            │
     │ /-/subscribe(topic)        │ /-/subscribe(topic)
     ▼                            ▼
┌──────────────────────────────────────┐
│  Registry                            │
│  topics: { orders: [A_host:A_port,   │
│                     B_host:B_port] } │
└──────────────────────────────────────┘
     ▲
     │ /-/find-subscribers(topic)
     │ → 返回 [A_host:A_port, B_host:B_port]
┌────┴────┐
│  App C  │  publish("orders", data)
│         │  → 逐个直推给 A 和 B
│  App C  │  (通过已有的 WebSocket 连接 push)
└─────────┘
```

三步流程：

```
1. 订阅：App A ──subscribe("orders")──→ Registry 保存
2. 查询：App C ──find-subscribers("orders")──→ Registry 返回地址列表
3. 推送：App C ──直推 push() ──→ App A, App B（不经过 Registry）
```

关键代码：

```ts
// Registry.ts — 新增三个保留路由

this.register('/-/subscribe', async ({ data, client }) => {
  const { topic } = data;
  const key = `${client.host}:${client.port}`;
  if (!this.topics.has(topic)) this.topics.set(topic, new Set());
  this.topics.get(topic)!.add(key);
});

this.register('/-/unsubscribe', async ({ data, client }) => {
  const { topic } = data;
  const key = `${client.host}:${client.port}`;
  this.topics.get(topic)?.delete(key);
});

this.register('/-/find-subscribers', async ({ data }) => {
  const { topic } = data;
  const keys = this.topics.get(topic);
  if (!keys) return { peers: [] };
  return {
    peers: Array.from(keys)
      .map(k => parseAddressKey(k))
      .filter(Boolean)
  };
});

// 断连时自动清理（复用现有 events.on('disconnect')）
this.events.on('disconnect', (client: Client) => {
  const key = `${client.host}:${client.port}`;
  for (const [, peers] of this.topics) {
    peers.delete(key);
  }
});
```

```ts
// Application.ts — publish 方法

async publish(topic: string, data: any) {
  // 1. 从 Registry 查订阅者列表
  const { response } = this.registry!.request('/-/find-subscribers', { topic });
  const result = await response<{ peers: Array<{ host: string; port: number }> }>();
  if (!result?.peers.length) return;

  // 2. 直推给每个订阅者
  await Promise.allSettled(
    result.peers.map(async (peer) => {
      const client = await this.connect(peer.host, peer.port);
      client.push(`/event/${topic}`, data);
    })
  );
}
```

**为什么是混合模式？** 注意第 2 步用的是 `this.connect()`——它会复用已有的连接缓存（`clients` Map），如果跟目标 peer 之前已经有过通信，不需要新建连接。这是 Registry 只存元数据不转发消息的底层基础：**peer 之间本来就有 WS 连接**，直接复用就行。

因此连接 `/-/subscribe` 的 route registration 实际上需要放在 `Application` 上去做：

```ts
// Application.ts — 构造时注册订阅路由

constructor(props: ApplicationProps) {
  // ...
  this.register('/-/subscribe', async ({ data }) => {
    const { response } = this.registry!.request('/-/subscribe', data);
    return (await response()).data;
  });
  this.register('/-/unsubscribe', async ({ data }) => {
    const { response } = this.registry!.request('/-/unsubscribe', data);
    return (await response()).data;
  });
}
```

#### 方案对比

| 对比项 | 本地 (A) | Registry 中转 (B) | 混合 (C) ✅ |
|--------|---------|-----------------|-----------|
| **跨实例有效** | ❌ | ✅ | ✅ |
| **消息延迟** | 直达（低） | 中转（中） | 直达（低） |
| **Registry 负载** | 无 | 高（所有消息经过） | 低（只做元数据查询） |
| **改造成本** | 低 | 中 | 中 |
| **需要 Registry** | 否 | 是 | 是 |

> **建议：默认采用方案 C（混合模式）。** 如果项目确实有单进程场景需要零依赖 pub/sub，可以额外做本地模式作为 fallback 或可选增强。但推荐实施时先做混合模式，本地模式可以在以后真的有性能瓶颈时再考虑。

### 2.5 需要改动的文件

| 文件 | 改动 |
|------|------|
| `packages/micro/src/registry.ts` | 新增 `topics` Map、`/-/subscribe`/`/-/unsubscribe`/`/-/find-subscribers` 路由、断连自动清理 |
| `packages/micro/src/application.ts` | 新增 `publish()` 方法、注册 `/-/subscribe`/`/-/unsubscribe` 转发路由 |

### 2.6 向后兼容

完全兼容。新增的保留路由和 `publish()` 方法不影响原有行为。
不订阅 topic 的 Application/Client 不需要任何改动。

---

## 3. 流式响应（Streaming）

### 3.1 要解决的问题

"一个请求的响应太大，或者响应是随时间产生的，需要分多次送达"。

典型场景：
- 分页查询："查 10000 条" → 分 10 批，每批 1000 条
- 进度推送："生成报表 20% → 50% → 100%"
- 实时数据：价格变化、日志流、文件逐块传输

### 3.2 现状：怎么做？

现在只能在 handler 里把所有数据攒好，一次返回：

```ts
// 伪代码：分页场景下被迫一次性返回
this.register('/search/orders', async ({ data }) => {
  const all = await db.queryAll(data);   // 一次查所有
  return all;                             // 一次返回
});
// 问题：如果数据量大，调用方要等很久才能看到第一个结果
```

### 3.3 设计方案

核心思路：**不新增消息类型**，而是在 `MessageTransferFormat` 上加一个 `stream?: boolean` 标记。

#### MessageTransferFormat 的改动

```ts
interface MessageTransferFormat<T = any> {
  id: number,
  mode: MESSAGE_MODEM_TYPE,    // 仍然是 REQUEST / RESPONSE / ABORT 三种
  twoway: boolean,
  stream?: boolean,            // ← 新增：标记此消息是流式通信的一部分
  data?: T
}
```

通信语义对比如下：

```
非流式（跟现在一样）：
  REQUEST  { id: 1, mode: REQUEST,  twoway: true }
  RESPONSE { id: 1, mode: RESPONSE, data: { status: 200, data: result } }

流式请求：
  REQUEST  { id: 2, mode: REQUEST,  twoway: true, stream: true }

流式响应（接收方返回多段 RESPONSE，直到 final=true）：
  RESPONSE { id: 2, mode: RESPONSE, stream: true, data: { status: 200, data: { seq: 0, payload: batch1, final: false } } }
  RESPONSE { id: 2, mode: RESPONSE, stream: true, data: { status: 200, data: { seq: 1, payload: batch2, final: false } } }
  RESPONSE { id: 2, mode: RESPONSE, stream: true, data: { status: 200, data: { seq: 2, payload: batch3, final: true  } } }
```

为什么要用 `seq`：

WebSocket 基于 TCP，同一条连接上的消息天然有序到达，所以传输层面不需要担心乱序。但 `seq` 在应用层提供了一层防御性校验：

| 场景 | 问题 | seq 的作用 |
|------|------|-----------|
| Consumer 消费慢 | 内部 buffer 可能积压 | 检测有没有 gap，发现丢段时报错或请求重传 |
| 断连重连 | 重连后第一个 chunk 可能重复/丢失 | 通过 seq 连续性判断完整性 |
| final 校验 | 不知道收到的段数是否完整 | 检查 `收到的段数 === seq + 1` |

```ts
// 流式数据的负载格式
interface StreamChunk<T = any> {
  seq: number,      // 序号，从 0 开始自增
  payload: T,       // 这一段的数据
  final?: boolean   // 默认 false，最后一段为 true
}
```

#### Server 侧：handler 返回 AsyncIterable

改造 `exec()` 签名，从只支持 Promise 改为同时支持 Promise 和 AsyncIterable：

```ts
// 现在的签名
protected abstract exec(data: any, context?: ...): Promise<any>;

// 改造后 —— 返回类型拓宽
protected abstract exec(
  data: any,
  context?: { signal?: AbortSignal }
): Promise<any> | AsyncIterable<any>;
```

`onRequest` 检测返回类型，分流处理：

```ts
private onRequest(msg) {
  const isStream = msg.stream === true;
  const result = this.exec(msg.data);

  if (isStream && isAsyncIterable(result)) {
    // 流式模式：逐段 yield，每段发一条 RESPONSE
    (async () => {
      let seq = 0;
      for await (const payload of result) {
        this.post({
          id: msg.id,
          mode: MESSAGE_MODEM_TYPE.RESPONSE,
          stream: true,
          data: {
            status: 200,
            data: { seq, payload, final: false },
          },
        });
        seq++;
      }
      // 最后一段
      this.post({
        id: msg.id,
        mode: MESSAGE_MODEM_TYPE.RESPONSE,
        stream: true,
        data: {
          status: 200,
          data: { seq, payload: undefined, final: true },
        },
      });
    })().catch(e => {
      // 异常处理
    });
  } else {
    // 非流式：跟现在一样
    exec(...).then(value => {
      this.post({ id: msg.id, mode: RESPONSE, ... });
    });
  }
}
```

handler 用 `async function*` 自然地表达分步返回：

```ts
this.register('/search/orders', async ({ data }) => {
  const cursor = db.queryCursor(data);
  for await (const batch of cursor.nextBatch(1000)) {
    yield batch;   // 每次 yield 发一段 RESPONSE(stream:true)
  }
  // 函数返回后自动发 final=true
});

this.register('/report/progress', async ({ data }) => {
  yield { stage: 'prep',  pct: 20 };
  yield { stage: 'calc',  pct: 50 };
  yield { stage: 'write', pct: 80 };
  yield { stage: 'done',  pct: 100, url: '...' };
});
```

#### Client 侧：新增 requestStream()

```ts
class Client {
  // 现有：非流式，返回 Promise
  request(url, data, timeout) → { abort, response: () => Promise<T> }
  
  // 新增：流式，返回 AsyncIterable
  requestStream(url, data, timeout?) → {
    abort: () => void,
    responses: AsyncIterable<StreamChunk<T>>,
  }
}
```

消费方代码：

```ts
const stream = client.requestStream('/search/orders', { status: 'pending' });
for await (const chunk of stream.responses) {
  console.log(`收到第 ${chunk.seq} 批:`, chunk.payload);
  renderTable(chunk.payload);
}
// final=true 后自动退出循环
```

#### Client 侧内部的实现

`requestStream()` 请求本身用 `_send()` 发出（加 `stream: true`），但 response 不消费 stack entry——需要另建一个 Map 来收流式数据：

```ts
// Client 内部新增
private readonly streams = new Map<number, {
  push: (chunk: StreamChunk) => void;
  close: () => void;
  cleanup: () => void;
}>();

// receive() → onResponse() 里分流
private onResponse(msg) {
  if (msg.stream) {
    // 流式响应：走 streams 通道
    const entry = this.streams.get(msg.id);
    if (!entry) return;
    if (msg.data.data.final) {
      entry.close();
      this.streams.delete(msg.id);
    } else {
      entry.push(msg.data.data);
    }
    return;
  }

  // 非流式：跟现在一样，走 stacks
  if (this.stacks.has(id)) {
    const { resolve, reject } = this.stacks.get(id)!;
    if (res?.status !== 200) reject(...);
    else resolve(res.data);
  }
}
```

注意：这里的 `onResponse` **复用已有路径**，不是新增消息类型的 case。跟旧 client 兼容的关键就在这里——流式响应就是 RESPONSE 消息，旧 client 收到 `msg.stream` 为 true 时，如果没有 `streams` 表，会走 `stacks` 路径 resolve 掉第一个 chunk，后面的 chunk 因为没有 pending 的 stack entry 被忽略。**不会崩，只是语义退化为"拿到第一个段就结束"。**

#### requestStream 的 AsyncIterable 实现

用 `PushableAsyncIterable` 模式——内部 push，外部 pull：

```ts
requestStream(url, data, timeout?) {
  const { abort, response } = this._send({ url, data }, timeout);
  
  // 标记请求为流式（底层 _send 给 REQUEST 带上 stream:true）
  // ... 
  
  return {
    abort,
    responses: {
      [Symbol.asyncIterator]: () => {
        const buffer: StreamChunk[] = [];
        let resolve: (chunk: IteratorResult<StreamChunk>) => void;
        let settled = false;
        
        this.streams.set(requestId, {
          push: (chunk) => {
            if (resolve) {
              resolve({ value: chunk, done: false });
              resolve = undefined;
            } else {
              buffer.push(chunk);
            }
          },
          close: () => {
            settled = true;
            if (resolve) resolve({ value: undefined, done: true });
          },
        });
        
        return {
          next: () => {
            if (buffer.length) {
              return Promise.resolve({ value: buffer.shift()!, done: false });
            }
            if (settled) return Promise.resolve({ value: undefined, done: true });
            return new Promise(r => { resolve = r; });
          },
        };
      },
    },
  };
}
```

#### 关于 ABORT 处理的改动

当前的 `onRequest` 用 `Promise.race` 处理取消：

```ts
Promise.race([
  this.exec(msg.data),
  new Promise((_, reject) => this.aborts.set(msg.id, reject)),
]).then(...)
```

对于流式 handler，`exec()` 可能长时间运行，`Promise.race` 只能**终止等待结果**，不能**终止 handler 本身的执行**。

改造方向：给 handler 注入一个 AbortSignal，让 handler 自己检查是否需要提前退出。

```ts
// 改造后的 exec 签名
protected abstract exec(
  data: any,
  context: {
    signal: AbortSignal,    // 调用方 ABORT 时触发
    ack?: () => void,       // 见第 5 节
  }
): Promise<any> | AsyncIterable<any>;
```

handler 可以这样响应取消：

```ts
this.register('/long-task', async ({ data, signal }) => {
  for await (const batch of db.cursor(data)) {
    if (signal.aborted) break;   // 调用方取消了
    yield batch;
  }
});
```

### 3.4 需要改动的文件

| 文件 | 改动 |
|------|------|
| `packages/message-modem/src/index.ts` | `MessageTransferFormat` 加 `stream?: boolean`、`exec()` 签名支持 AsyncIterable 和 context、`onRequest` 分流逻辑、`onResponse` 增加 `msg.stream` 分支 |
| `packages/message-ws/src/index.ts` | 无需改动 |
| `packages/micro/src/client.ts` | 新增 `streams` Map、`requestStream()` 方法、`onResponse` 分流 |

### 3.5 向后兼容

**天然的兼容性。** 流式数据走的是 `RESPONSE` 消息类型，不是新类型。旧 client 收到带 `stream: true` 的 RESPONSE 时的行为：

- 如果响应等到了第一个 chunk → 当成正常结果 resolve（拿到第一段，后续的丢失）
- 如果响应还没等到 → stack entry 还在，resolve 第一个，下面的因 entry 已被删除而忽略

**不会崩溃，只是流式退化为非流式（只拿第一段）**。

> 是否需要 feature detection 取决于业务要求。如果严格需要保证流式语义，可以在 `/-/handshake` 握手时声明支持。

---

## 4. Scatter/Gather（扇出聚合）

### 4.1 要解决的问题

"向某个 namespace 的**所有**服务实例发请求，收集全部响应再做聚合"。

典型场景：
- 搜索引擎同时查"订单"、"商品"、"用户"三个集群
- 管理面板的健康检查遍历所有依赖服务
- 配置管理批量推送更新到所有实例

### 4.2 现状：怎么做？

`Application.call()` 走的是 Registry `/find` 返回**一个**随机 peer：

```ts
call(namespace, url, data) → Promise<T>   // 只发给一个 peer
```

如果要发给多个，只能手动多次 connect：

```ts
// 手动感觉
const results = await Promise.all([
  app.call('order-service', '/stats', {}),
  app.call('product-service', '/stats', {}),
  app.call('user-service', '/stats', {}),
]);
```

没问题，但 `callAll('order-service', '/stats')` 不行——你没法让 `call` 发给多个实例。

### 4.3 设计方案（不用改协议层）

#### Registry 新增 /-find-all

现有 `/-/find` 只返回一个随机 peer。加一个新路由返回全部：

```ts
// Registry.ts
this.register('/-/find-all', async ({ data }) => {
  const { namespace } = data;
  const keys = this.namespaces.get(namespace);
  if (!keys || keys.size === 0) return { peers: [] };
  
  return {
    peers: Array.from(keys).map(k => parseAddressKey(k)).filter(Boolean)
  };
});
```

`Registry` 的 `namespaces` 已经是 `Map<string, Set<string>>`，直接读就行。

#### Application 新增 callAll()

```ts
class Application {
  async callAll<T = any>(
    namespace: string, 
    url: string, 
    data: any,
    options?: {
      timeout?: number;
      mode?: 'all' | 'first' | 'quorum';  // 聚合策略
      quorum?: number;                      // quorum 模式需要的成功数
    }
  ): Promise<Array<{ success: true; value: T } | { success: false; reason: Error }>> {
    
    // 1. 从 Registry 获取所有 peer
    const peers = await this.findAllFromRegistry(namespace);
    if (!peers.length) throw new Error(`No peers found for namespace: ${namespace}`);
    
    // 2. 并行连接 / 发送请求
    const requests = peers.map(peer => 
      this.connect(peer.host, peer.port)
        .then(client => client.request(url, data, options?.timeout))
        .then(res => res.response<T>())
        .then(value => ({ success: true as const, value }))
        .catch(reason => ({ success: false as const, reason }))
    );
    
    // 3. 根据策略收集结果
    switch (options?.mode ?? 'all') {
      case 'first':
        return Promise.race(requests.map(async r => [await r]));
      case 'quorum':
        return collectQuorum(requests, options?.quorum ?? Math.ceil(peers.length / 2));
      case 'all':
      default:
        return Promise.all(requests);
    }
  }
  
  // 直接向 Registry 查所有 peer，不走 get() 的缓存
  private async findAllFromRegistry(namespace: string) {
    if (!this.registry) throw new Error('Registry not found');
    const { response } = this.registry.request('/-/find-all', { namespace });
    const result = await withTimeout(
      response<{ peers: Array<{ host: string; port: number }> }>(),
      this._registryLookupTimeoutMs,
      'Registry /-/find-all'
    );
    return result?.peers ?? [];
  }
}
```

#### 聚合策略详解

```
mode: 'all'     → 等所有请求完成（Promise.allSettled 风格）
mode: 'first'   → 返回最快的那一个结果（Promise.race 风格）
                  ⚠ 注意：其他请求仍在进行，需要 dispose 掉多余的连接
mode: 'quorum'  → 等 N 个请求成功就返回（N 通常 > 一半）
                  典型用于"多数共识"场景
```

`first` 模式的连接泄漏问题需要关注——最快的结果回来后就该关掉其他还在跑的请求。

#### 连接复用

`connect()` 已经带缓存了：

```ts
protected async connect(host: string, port: number) {
  const key = `${host}:${port}`;
  if (this.clients.has(key)) return this.clients.get(key)!;
  // ...新建连接并缓存
}
```

`callAll()` 天然享受已有连接的复用。如果 `callAll()` 用的是 registry 返回的全量地址，多数连接可能已经存在（之前被 `get()` 访问过）。

### 4.4 需要改动的文件

| 文件 | 改动 |
|------|------|
| `packages/micro/src/registry.ts` | 新增 `/-/find-all` 路由 |
| `packages/micro/src/application.ts` | 新增 `callAll()` 方法、`findAllFromRegistry()` 私有方法 |

### 4.5 向后兼容

完全兼容。新增路由和方法不影响现有行为。

---

## 5. Request/Acknowledge（请求+确认）

### 5.1 要解决的问题

"请求发过去，只要对方确认'收到了'就算成功，实际处理异步执行"。

典型场景：
- 异步任务提交："帮我处理这批数据，处理完叫我"
- 消息队列风格：发送者只关心"任务进了队列"，不关心任务何时完成
- 耗时操作的进度分离：先确认"请求已接收、参数合法"，后续处理结果通过其他方式获得

### 5.2 现状：怎么做？

现在只有两个选择：
- `push()` — 发完不管，不知道对方收到没有
- `request()` — 必须等到最终结果，超时抛错

没有一个中间状态——"我收到了，正在处理，但还没完"。

### 5.3 设计方案

#### ACK 消息类型

在协议层新增一个消息类型——ACK——表示"我收到了你的请求并已接过来了，处理中，别急"。

```
新增：MESSAGE_MODEM_TYPE.ACK

格式：
{
  id: number,        // 关联到原始请求的 id
  mode: ACK,         // 新类型
  twoway: false,
  data: {
    status: 'accepted' | 'rejected',
    message?: string,  // rejected 时附带原因（如参数校验失败）
  }
}
```

ACK 是单向消息，不需要回复。

#### Server 侧：exec() 注入 ack() 回调

在 handler 的执行过程中，通过 context 注入 `ack()`：

```ts
// 改造 exec() 签名
protected abstract exec(
  data: any,
  context: {
    ack: (status?: 'accepted' | 'rejected', message?: string) => void;
    signal: AbortSignal;
  }
): Promise<any>;
```

handler 可以这样用：

```ts
this.register('/batch-process', async ({ data, ack }) => {
  // 1. 先校验参数
  if (!data.fileId) {
    ack('rejected', 'Missing fileId');
    return;  // 快速失败
  }
  
  // 2. 确认接收
  ack('accepted');
  
  // 3. 慢慢处理
  const result = await slowProcess(data);
  return result;  // 处理完再发 RESPONSE
});
```

#### Client 侧：request() 返回值增加 ack 信号

```ts
// 现在的返回类型
{ 
  abort: () => void; 
  response: () => Promise<T> 
}

// 改造后
{ 
  abort: () => void;
  ack: () => Promise<{ status: 'accepted' | 'rejected', message?: string }>;
  response: () => Promise<T>;
}
```

调用方可以按需等待 ack：

```ts
const req = client.request('/batch-process', { fileId: 'xxx' });

// 方式 A：只确认任务入队
const ackResult = await req.ack();
if (ackResult.status === 'rejected') {
  console.log('被拒绝了:', ackResult.message);
  return;
}
console.log('任务已入队，回去等通知');

// 方式 B：直接等最终结果（跟现在一样）
const data = await req.response();  // 先等 ack，再等 result

// 方式 C：只关心 ack，不等结果
req.ack().then(() => {
  console.log('已确认，可以返回了');
});
// req.response 不调用，超时后释放
```

#### onRequest 的改造（核心改动）

当前的 `onRequest` 是**一阶段**的：

```
接收 REQUEST → 执行 exec() → 发 RESPONSE
```

改造后变为**两阶段**：

```
接收 REQUEST → 执行 exec()
               ├─ handler 调 ack() → 发 ACK → 继续执行 → 发 RESPONSE
               └─ handler 不调 ack() → 直接执行 → 发 RESPONSE（跟现在一样）
```

代码骨架：

```ts
private onRequest(msg) {
  let ackCalled = false;
  
  const context = {
    ack: (status: 'accepted' | 'rejected', message?: string) => {
      ackCalled = true;
      if (ackCalled) return;  // 防重复
      this.post({
        id: msg.id,
        mode: MESSAGE_MODEM_TYPE.ACK,
        data: { status, message },
      });
    },
    signal: ...,
  };
  
  this.exec(msg.data, context).then(value => {
    // 如果已经发过 ACK，这里只发 RESPONSE
    // 如果没发过 ACK，按原有行为（REQUEST → RESPONSE）
    this.post({
      id: msg.id,
      mode: MESSAGE_MODEM_TYPE.RESPONSE,
      data: { status: 200, data: value, message: '' },
    });
  }).catch(e => {
    // 异常处理...
  });
}
```

#### Client 侧：_send() 改造

现在的 `_send()` 方法——`_write()` 里创建完请求后直接把 `{ resolve, reject }` 存入 `stacks`，等待 RESPONSE 到来。

ACK 的处理需要在 `stacks` 之外另开一条通道：

```ts
// MessageModem 新增
private readonly ackStacks = new Map<number, {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}>();

// receive() 增加 ACK 分支
case MESSAGE_MODEM_TYPE.ACK:
  this.onAck(msg);
  break;

private onAck(msg) {
  const entry = this.ackStacks.get(msg.id);
  if (entry) {
    entry.resolve(msg.data);
    this.ackStacks.delete(msg.id);
  }
}

// _write() 改造：返回 ack
return {
  abort: () => { ... },
  ack: () => new Promise((resolve, reject) => {
    this.ackStacks.set(state.id, { resolve, reject });
    // 也要加超时，防止 handler 永远不调 ack()
  }),
  response: ...,  // 跟现在一样
};
```

#### 超时处理

ack 本身也应该有超时——不然 handler 不调 ack() 的话，ack() 就永远不 resolve：

```ts
ack: () => {
  const ackTimeout = 5000;  // 5s 内 handler 没调 ack 就算失败
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.ackStacks.delete(state.id);
      reject(new TimeoutException('ACK timeout'));
    }, ackTimeout);
    
    this.ackStacks.set(state.id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject,
    });
  });
}
```

建议把 ack 的超时设为比请求超时更短的值，让调用方能快速判断"请求是否被接收"。

### 5.4 需要改动的文件

| 文件 | 改动 |
|------|------|
| `packages/message-modem/src/index.ts` | 新增 `MESSAGE_MODEM_TYPE.ACK`、「ackStacks」Map、`onAck()` 处理、`_write()` 返回 ack |
| `packages/message-modem/src/exception.ts` | 可能不需要，复用 TimeoutException |
| `packages/micro/src/client.ts` | request() 返回值增加 ack |

### 5.5 向后兼容

**兼容的。** 旧 client/server 不认识 ACK 消息类型，直接忽略即可（不会抛错）。没有 ack 时 `ack()` 超时后 reject，调用方捕获就行。

---

## 6. 各模式改造成本一览

```
                             协议层     传输层      Server     Client     Registry     Application
                            (modem)    (ws)       (micro)    (micro)    (micro)      (micro)
Pub/Sub (混合)                无        无         无         无         中           中
Streaming                     中        无         中         中         无           无
Scatter/Gather                无        无         无         无         中           中
Request/Acknowledge           低        无         中         低         无           无
```

**成本释义：**
- **低** = 半天内，几十行代码，不涉及架构变动
- **中** = 1-3 天，涉及某个包的内部重构
- **高** = 跨多个包的架构改动，需要版本协调

### 详细成本

| 模式 | 成本 | 原因 |
|------|------|------|
| **Pub/Sub (混合)** | **中** | 不改协议层。Registry 加 topics 表和 3 个路由，Application 加 publish() 方法 |
| **Scatter/Gather** | **低** | 不改协议层。Registry 加一个路由 (`/-/find-all`) + Application 加 `callAll()` 方法 |
| **ACK** | **中** | 协议层加一个消息类型。`MessageModem` 和 `Client` 的改动不大，核心是 `exec()` 签名扩展 |
| **Streaming** | **中-高** | 协议层加消息类型 + AsyncIterable 检测 + `onRequest` 改造（Promise.race 替换）+ Client 侧 AsyncIterable 消费 |

---

## 7. 推荐实施顺序

结合改造成本和使用频率，建议分三阶段：

### 第一阶段：快速出成果（不动协议）

```
1. Pub/Sub (混合模式) ─── Registry + Application，加 topics 管理和 publish()
2. Scatter/Gather     ─── Registry 加 /-find-all，Application 加 callAll()
```

这两个可以并行做，改动互不依赖，核心功能当天可用。Scatter/Gather 更便宜，但 Pub/Sub 更常用。

### 第二阶段：拓展协议

```
3. ACK ─── 协议层加 ACK 类型
4. 统一 exec() 签名（context 参数）
```

ACK 引入了 `ack()` 回调，为后续 Streaming 铺路。
`exec()` 的 context 参数设计要兼顾 Streaming 的 signal/AsyncIterable 需求。

### 第三阶段：流式

```
5. Streaming ─── 协议层加 CHUNK 类型
                 ─── onRequest 重构（from Promise.race to callback-driven）
                 ─── Client requestStream()
```

Streaming 改动量最大，且依赖第二阶段的 `exec()` 签名改造，放在最后最稳妥。

---

## 附录：协议层消息类型总览

```
当前 (3种消息类型):

┌─────────┐      REQUEST      ┌─────────┐
│  Client │ ────────────────→ │  Server │
│         │ ←──────────────── │         │
│         │      RESPONSE     │         │
│         │ ──── ABORT ────→ │         │
└─────────┘                   └─────────┘

扩展后 (消息类型仍是 3 种，新增 stream 标记和 ACK 类型):

┌─────────┐      REQUEST      ┌─────────┐       ┌──────────┐
│  Client │ ────────────────→ │  Server │ ←───→ │ Registry │
│         │ ←──────────────── │         │       └──────────┘
│         │    RESPONSE       │         │
│         │  (stream:true)    │         │
│         │ ←── ACK ──────── │         │
│         │ ──── ABORT ────→ │         │
└─────────┘                   └─────────┘

标记新增：
  stream: boolean ─── 加在 MessageTransferFormat 上
                        REQUEST 带它表示"我要流式响应"
                        RESPONSE 带它表示"这是流式的一段数据"
                        data.payload 内嵌 StreamChunk { seq, payload, final }

类型新增：
  ACK ─── 请求确认（Server → Client，独立于 RESPONSE）
```
