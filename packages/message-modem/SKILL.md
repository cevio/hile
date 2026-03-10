---
name: message-modem
description: Code generation and contribution rules for @hile/message-modem. Use when editing this package or when the user asks about @hile/message-modem patterns or API.
---

# @hile/message-modem

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/message-modem` 是一个 **传输无关的请求/响应消息通信抽象层**。它将底层传输（WebSocket、postMessage、IPC 等）与业务逻辑解耦，提供统一的 _send/receive 语义。

核心职责：

- 自增 ID 管理与安全重置（超过 `MAX_SAFE_INTEGER` 时归零）
- 请求/响应配对（通过 ID + stacks Map）
- 超时控制（基于 `AbortController` + `setTimeout`）
- 主动中止（abort）：发送方可中止等待，接收方可取消正在执行的任务
- 错误传播：`Exception` 携带 `status`；非 `Exception` 错误映射为 500

导出方式：

主入口 `index.ts` 通过 `export * from './exception'` 重新导出所有异常类，因此使用者可以从 `@hile/message-modem` 统一导入所有类型：

```typescript
import { MessageModem, Exception, AbortException, TimeoutException, MESSAGE_MODEM_TYPE } from '@hile/message-modem';
```

继承关系：

```
MessageModem (abstract)
  ├── post(data)    — 子类实现：如何发送到远端
  └── exec(data)    — 子类实现：如何处理收到的请求
```

---

## 2. 类型签名

```typescript
// ---- 枚举 ----
enum MESSAGE_MODEM_TYPE {
  REQUEST,    // 请求
  RESPONSE,   // 响应
  ABORT,      // 中止
}

// ---- 传输格式 ----
interface MessageTransferFormat<T = any> {
  id: number;
  mode: MESSAGE_MODEM_TYPE;
  twoway: boolean;
  data?: T;
}

// ---- 响应格式 ----
interface MessageReturnFormat<T = any> {
  status: string | number;
  data: T;
  message: string;
}

// ---- 异常 ----
class Exception extends Error {
  readonly status: number | string;
  constructor(status: number | string, msg: string);
}

class TimeoutException extends Exception {
  static readonly code = 'ETIMEDOUT';
  constructor(msg?: string);  // 默认 'Timeout'
}

class AbortException extends Exception {
  static readonly code = 'ECONNABORTED';
  constructor(msg?: string);  // 默认 'Abort'
}

// ---- 抽象基类 ----
abstract class MessageModem {
  protected abstract post<T>(data: MessageTransferFormat<T>): void;
  protected abstract exec(data: any): Promise<any>;
  protected _send<T>(data: T, timeout?: number): {
    abort: () => void;
    response: <U = any>() => Promise<U>;
  };
  protected _push<T>(data: T, timeout?: number): {
    abort: () => void;
    response: <U = any>() => Promise<U>;
  };
  public receive(msg: MessageTransferFormat): void;
}
```

---

## 3. 代码生成模板与规则

### 3.1 子类实现模板

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
    // 处理远端请求的业务逻辑
    return handleRequest(data);
  }

  // 暴露 _send 为 public
  public request<T>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 3.2 postMessage 场景模板

```typescript
class IframeModem extends MessageModem {
  constructor(private target: Window, private origin: string) {
    super();
    window.addEventListener('message', (e) => {
      if (e.origin === origin) this.receive(e.data);
    });
  }

  protected post<T>(data: MessageTransferFormat<T>): void {
    this.target.postMessage(data, this.origin);
  }

  protected async exec(data: any): Promise<any> {
    return handleIframeRequest(data);
  }
}
```

### 3.3 强制规则

| 规则 | 说明 |
|------|------|
| **必须实现 `post` 和 `exec`** | 两个 abstract 方法缺一不可 |
| **`_send` 是 `protected`** | 子类应自行决定暴露方式和命名 |
| **`_push` 是 `protected`** | 单向推送（`twoway: false`），接收方不回复 RESPONSE |
| **`receive` 是 `public`** | 必须由外部消息源（事件监听器）调用 |
| **传输格式必须保持原样** | `post` 发送的对象结构不可修改，对端的 `receive` 依赖完整的 `MessageTransferFormat` |
| **`exec` 抛出 `Exception` 时 status 会透传** | 其他 Error 一律映射为 500 |
| **timeout 默认 30s** | 可通过 `_send(data, ms)` 覆盖 |
| **abort 后 promise reject `AbortException`** | 不要 catch 后吞掉，保持语义清晰 |

### 3.4 反模式

```typescript
// ❌ 不要在 post 中做异步操作
protected async post(data) { await fetch(...); }
// ✅ post 应该是同步的，异步传输应缓冲

// ❌ 不要直接修改 MessageTransferFormat 结构
this.post({ ...data, extra: 'field' });
// ✅ 业务数据放在 data 字段内

// ❌ 不要忘记连接 receive
// ✅ 在构造函数中绑定消息事件 → this.receive(parsed)

// ❌ 不要在 exec 中吞掉错误
protected async exec(data) { try { ... } catch { return null; } }
// ✅ 让错误冒泡，框架会处理错误响应
```
