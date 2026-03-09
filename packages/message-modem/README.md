# @hile/message-modem

传输无关的请求/响应消息通信抽象层。将底层传输机制（WebSocket、postMessage、IPC 等）与业务逻辑解耦，提供统一的 send/receive 语义。

## 安装

```bash
pnpm add @hile/message-modem
```

## 核心特性

- **传输无关** — 子类只需实现 `post`（如何发送）和 `exec`（如何处理），即可运行于任何通信通道
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
    return this.send(data, timeout);
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
| `send(data, timeout?)` | `protected` | 发送请求，返回 `{ abort, response }` |
| `receive(msg)` | `public` | 接收消息入口，根据 mode 分发处理 |

### `send` 返回值

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
  data?: T;
}

// 响应数据格式
interface MessageReturnFormat<T = any> {
  status: string | number;
  data: T;
  message: string;
}
```

## 消息流转

```
发送方                        接收方
  │                             │
  │  send(data)                 │
  │──── REQUEST ───────────────►│
  │                             │ exec(data)
  │                             │
  │◄──── RESPONSE ──────────────│
  │  resolve(data)              │
  │                             │
  │  abort()                    │
  │──── ABORT ─────────────────►│
  │                             │ 取消 exec
```

## 适用场景

- **iframe 通信** — 父子页面 postMessage
- **WebSocket** — 客户端与服务端双向通信
- **Web Worker** — 主线程与 Worker 通信
- **Electron IPC** — 主进程与渲染进程通信
- **Node.js child_process** — 父子进程通信

## License

MIT
