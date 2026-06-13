# @hile/message-modem

传输无关的请求/响应消息通信抽象层。将底层传输机制（WebSocket、postMessage、IPC 等）与业务逻辑解耦，提供统一的 _send/receive 语义。

## 安装

```bash
pnpm add @hile/message-modem
```

## 核心特性

- **传输无关** — 子类只需实现 `post`（如何发送）和 `exec`（如何处理），即可运行于任何通信通道
- **双向请求/响应** — `_send` 发送请求并等待对端响应（`twoway: true`）
- **单向推送** — `_push` 发送消息无需对端响应（`twoway: false`）
- **流式传输** — `_stream` 发送流式请求，对端返回 async generator 时分块回传，发送方获得 `Readable` stream
- **请求/响应配对** — 自增 ID + Promise 栈，自动配对请求与响应
- **超时控制** — 默认 30 秒，可按请求自定义
- **主动中止** — 发送方可 abort 等待，接收方可取消正在执行的任务
- **错误传播** — `Exception` 携带 status 码透传；普通 Error 映射为 500

## 快速开始

### 第一步：继承并实现抽象方法

```typescript
import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';

class WebSocketModem extends MessageModem {
  constructor(private ws: WebSocket) {
    super();
    ws.addEventListener('message', (e) => {
      this.receive(JSON.parse(e.data));
    });
  }

  protected post<T>(data: MessageTransferFormat<T>): void {
    this.ws.send(JSON.stringify(data));
  }

  protected async exec(data: any): Promise<any> {
    // 处理远端请求
    return handleRequest(data);
  }

  // 暴露发送方法
  public request<T>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 第二步：发送请求

```typescript
const modem = new WebSocketModem(ws);

const { abort, response } = modem.request({ action: 'getUser', id: 1 });

// 等待响应
const user = await response();
console.log(user);

// 或中止请求
abort();
```

### 第三步：处理超时与异常

所有异常类均从主入口导出，无需单独引入：

```typescript
import { AbortException, Exception } from '@hile/message-modem';

try {
  // 5 秒超时
  const result = await modem.request(data, 5000).response();
} catch (e) {
  if (e instanceof AbortException) {
    console.log('请求超时或被中止');
  } else if (e instanceof Exception) {
    console.log(`远端错误 [${e.status}]: ${e.message}`);
  }
}
```

## API

### `MessageModem`（抽象类）

| 方法 | 可见性 | 说明 |
|------|--------|------|
| `post(data)` | `protected abstract` | 子类实现：如何将消息发送到远端 |
| `exec(data)` | `protected abstract` | 子类实现：如何处理收到的请求，返回 Promise |
| `_send(data, opts?)` | `protected` | 发送双向请求（`twoway: true`），返回 `{ abort, response }` |
| `_push(data, opts?)` | `protected` | 发送单向推送（`twoway: false`），无返回值，接收方不回复 RESPONSE |
| `_stream(data, opts?)` | `protected` | 发送流式请求，返回 `Readable` stream。对端 `exec()` 须返回 async generator |
| `receive(msg)` | `public` | 接收消息入口，根据 mode 分发处理 |

### `_send` 返回值

| 属性 | 类型 | 说明 |
|------|------|------|
| `abort` | `() => void` | 中止本次请求 |
| `response` | `<U>() => Promise<U>` | 等待远端响应 |

### 消息类型

| 枚举值 | 说明 |
|--------|------|
| `MESSAGE_MODEM_TYPE.REQUEST` | 请求消息 |
| `MESSAGE_MODEM_TYPE.RESPONSE` | 响应消息 |
| `MESSAGE_MODEM_TYPE.ABORT` | 中止消息 |

### 异常类

| 类 | status | 默认 message | 说明 |
|------|--------|------|------|
| `Exception` | 自定义 | 自定义 | 基础异常，携带 status |
| `TimeoutException` | `ETIMEDOUT` | `Timeout` | 超时异常 |
| `AbortException` | `ECONNABORTED` | `Abort` | 中止异常 |

### 消息格式

```typescript
// 传输格式
interface MessageTransferFormat<T = any> {
  id: number;
  mode: MESSAGE_MODEM_TYPE;
  twoway: boolean;
  stream?: boolean;      // true → 流式模式
  data?: T;
}

// 响应数据格式
interface MessageReturnFormat<T = any> {
  status: string | number;
  data: T;
  message: string;
}

// 流式分块格式（stream=true 时 RESPONSE 携带）
interface MessageStreamChunk<T = any> {
  status: string | number;
  seq: number;           // 块序号，从 0 递增
  payload: T;            // 块数据
  final: boolean;        // true → 最后一块
}
```

## 消息流转

### 双向模式（`_send`）

```
发送方                        接收方
  │                             │
  │  _send(data)                │
  │──── REQUEST (twoway) ──────►│
  │                             │ exec(data)
  │                             │
  │◄──── RESPONSE ──────────────│
  │  resolve(data)              │
  │                             │
  │  abort()                    │
  │──── ABORT ─────────────────►│
  │                             │ 取消 exec
```

### 单向模式（`_push`）

```
发送方                        接收方
  │                             │
  │  _push(data)                │
  │──── REQUEST (!twoway) ─────►│
  │                             │ exec(data)
  │                             │ （不回复 RESPONSE）
```

### 流式模式（`_stream`）

```
发送方                        接收方
  │                             │
  │  _stream(data)              │
  │──── REQUEST (stream) ──────►│
  │                             │ exec(data) → async generator
  │                             │
  │◄─── RESPONSE (seq:0) ───────│ for await (chunk of gen)
  │◄─── RESPONSE (seq:1) ───────│
  │◄─── RESPONSE (seq:2) ───────│
  │  ...                        │
  │◄─── RESPONSE (final) ───────│ 迭代结束
  │                             │
  │  abort()                    │
  │──── ABORT ─────────────────►│ 取消迭代
```

对端 `exec()` 返回 `AsyncIterable` 时，`MessageModem` 自动检测并进入分块传输模式。发送方通过 `for await` 消费 `Readable` stream。

**何时用**：大数据集、实时事件流、LLM token 输出、进度上报等需要持续推送的场景。
**何时不用**：单次请求/响应 —— 用 `_send()` 即可，无需 `_stream()`。

## 适用场景

- **iframe 通信** — 父子页面 postMessage
- **WebSocket** — 客户端与服务端双向通信
- **Web Worker** — 主线程与 Worker 通信
- **Electron IPC** — 主进程与渲染进程通信
- **Node.js child_process** — 父子进程通信

## License

MIT
