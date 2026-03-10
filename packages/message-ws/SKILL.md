---
name: message-ws
description: Code generation and contribution rules for @hile/message-ws. Use when editing this package or when the user asks about @hile/message-ws patterns or API.
---

# @hile/message-ws

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/message-ws` 是 `@hile/message-modem` 的 **WebSocket（ws 模块）抽象实现**，用于客户端与服务端之间的请求/响应通信。

`MessageWs` 本身是 **抽象类**，实现了 `post`（通过 `ws.send` 发送 JSON），`exec` 方法留给子类实现。

继承链：

```
MessageModem (abstract)     ← post + exec 均抽象
  └── MessageWs (abstract)  ← 实现 post（JSON + ws.send），exec 仍抽象
        └── 用户子类         ← 实现 exec
```

消息通过 JSON 序列化/反序列化传输。

---

## 2. 类型签名

```typescript
import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import type WebSocket from 'ws';

abstract class MessageWs extends MessageModem {
  constructor(ws: WebSocket);

  protected abstract exec(data: any): Promise<any>;

  // 发送双向请求（protected，子类自行暴露）
  protected _send<T = any>(data: T, timeout?: number): {
    abort: () => void;
    response: <U = any>() => Promise<U>;
  };

  // 发送单向推送（protected，子类自行暴露）
  protected _push<T = any>(data: T, timeout?: number): {
    abort: () => void;
    response: <U = any>() => Promise<U>;
  };

  public dispose(): void;
}
```

---

## 3. 代码生成模板与规则

### 3.1 基本子类模板

```typescript
import { MessageWs } from '@hile/message-ws';

class MyWs extends MessageWs {
  protected async exec(data: any): Promise<any> {
    switch (data?.action) {
      case 'ping': return 'pong';
      default: return data;
    }
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 3.2 客户端模板

```typescript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');
ws.on('open', () => {
  const modem = new MyWs(ws);

  modem.request({ action: 'getUser', id: 1 })
    .response<User>()
    .then(console.log);
});
```

### 3.3 服务端模板

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  const modem = new MyWs(ws);
  // modem 自动监听 ws 消息并处理请求
});
```

### 3.4 强制规则

| 规则 | 说明 |
|------|------|
| **必须继承并实现 `exec`** | `MessageWs` 是抽象类 |
| **必须传入已连接的 `WebSocket`** | 或在 `open` 事件后创建 |
| **消息通过 JSON 传输** | `post` 内部 `JSON.stringify`，收到消息 `JSON.parse` |
| **`readyState !== OPEN` 时 `post` 会抛错** | 确保连接已建立 |
| **用完必须 `dispose()`** | 避免内存泄漏 |

### 3.5 反模式

```typescript
// ❌ 连接未建立就创建 modem 并发送
const ws = new WebSocket('ws://...');
const modem = new MyWs(ws);
modem.request('hi'); // readyState 不是 OPEN → 抛错

// ✅ 等待 open 事件
ws.on('open', () => {
  const modem = new MyWs(ws);
  modem.request('hi');
});

// ❌ 不能直接实例化
const modem = new MessageWs(ws); // abstract

// ✅ 继承并实现 exec，自行暴露 _send
class MyWs extends MessageWs {
  protected async exec(data: any) { return data; }
  public request<T = any>(data: T, timeout?: number) { return this._send(data, timeout); }
}

// ❌ 传输非 JSON 安全的数据
modem.request(new Map()); // Map 序列化会丢失

// ✅ 只传 JSON 安全数据
modem.request({ key: 'value' });
```
