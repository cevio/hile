---
name: message-ipc
description: Code generation and contribution rules for @hile/message-ipc. Use when editing this package or when the user asks about @hile/message-ipc patterns or API.
---

# @hile/message-ipc

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/message-ipc` 是 `@hile/message-modem` 的 **Node.js IPC 抽象实现**，用于父子进程间的请求/响应通信。

`MessageIpc` 本身是 **抽象类**，只实现了 `post`（通过 IPC 通道发送）和消息监听，`exec` 方法留给子类实现具体的请求处理逻辑。

继承链：

```
MessageModem (abstract)        ← post + exec 均抽象
  └── MessageIpc (abstract)    ← 实现 post，exec 仍抽象
        └── 用户子类            ← 实现 exec
```

---

## 2. 类型签名

```typescript
import type { ChildProcess } from 'node:child_process';
import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';

type IpcExecHandler = (data: any) => Promise<any>;

abstract class MessageIpc extends MessageModem {
  constructor(channel?: ChildProcess);

  // 子类必须实现
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

  // 移除消息监听
  public dispose(): void;
}
```

---

## 3. 代码生成模板与规则

### 3.1 基本子类模板

```typescript
import { MessageIpc } from '@hile/message-ipc';

class MyIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> {
    // 处理对端发来的请求
    switch (data?.action) {
      case 'ping':
        return 'pong';
      default:
        return data;
    }
  }

  // 自行暴露发送方法
  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 3.2 父进程端模板

```typescript
import { fork } from 'node:child_process';

class ParentIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> {
    // 处理子进程发来的请求
    return { reply: 'from parent', query: data };
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

const child = fork('./worker.js');
const ipc = new ParentIpc(child);

const result = await ipc.request({ action: 'compute', value: 42 }).response();
console.log(result);

ipc.dispose();
child.kill();
```

### 3.3 子进程端模板

```typescript
// worker.js
import { MessageIpc } from '@hile/message-ipc';
import { Exception } from '@hile/message-modem';

class WorkerIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> {
    if (data.action === 'compute') return data.value * 2;
    if (data.action === 'restricted') throw new Exception(403, 'not allowed');
    return data;
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

const ipc = new WorkerIpc(); // 无参数 → 使用 process
```

### 3.4 强制规则

| 规则 | 说明 |
|------|------|
| **必须继承 `MessageIpc` 并实现 `exec`** | `MessageIpc` 是抽象类，不能直接实例化 |
| **父进程端必须传入 `ChildProcess`** | `fork()` 返回值 |
| **子进程端不传参数** | 自动使用 `process`，要求进程通过 `fork()` 启动 |
| **用完必须 `dispose()`** | 避免内存泄漏 |
| **`_send` 是 `protected`** | 子类需自行暴露为 public 方法（如 `request`） |
| **`_push` 是 `protected`** | 单向推送，接收方不回复 RESPONSE。子类自行暴露 |

### 3.5 反模式

```typescript
// ❌ 不能直接实例化 MessageIpc
const ipc = new MessageIpc(child); // TypeError: Cannot construct abstract class

// ✅ 继承并实现 exec，自行暴露 _send
class MyIpc extends MessageIpc {
  protected async exec(data: any) { return data; }
  public request<T = any>(data: T, timeout?: number) { return this._send(data, timeout); }
}
const ipc = new MyIpc(child);

// ❌ 不要用 spawn
const child = spawn('node', ['worker.js']);
// ✅ 用 fork
const child = fork('./worker.js');

// ❌ 不要忘记 dispose
// ✅ 用完清理
ipc.dispose();
child.kill();
```
