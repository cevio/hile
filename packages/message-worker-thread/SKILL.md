---
name: message-worker-thread
description: Code generation and contribution rules for @hile/message-worker-thread. Use when editing this package or when the user asks about @hile/message-worker-thread patterns or API.
---

# @hile/message-worker-thread

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/message-worker-thread` 是 `@hile/message-modem` 的 **Node.js Worker Threads 抽象实现**，用于主线程与 Worker 线程之间的请求/响应通信。

`MessageWorkerThread` 本身是 **抽象类**，实现了 `post`（通过 `postMessage` 发送），`exec` 方法留给子类实现。

继承链：

```
MessageModem (abstract)              ← post + exec 均抽象
  └── MessageWorkerThread (abstract) ← 实现 post，exec 仍抽象
        └── 用户子类                  ← 实现 exec
```

通道类型：

- 主线程端：传入 `Worker` 实例或 `MessagePort`
- Worker 线程端：不传参数，自动使用 `parentPort`

---

## 2. 类型签名

```typescript
import { MessageModem, type MessageTransferFormat } from '@hile/message-modem';
import type { Worker, MessagePort } from 'node:worker_threads';

abstract class MessageWorkerThread extends MessageModem {
  constructor(port?: Worker | MessagePort);

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
import { MessageWorkerThread } from '@hile/message-worker-thread';

class MyWorkerThread extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> {
    switch (data?.action) {
      case 'ping':
        return 'pong';
      default:
        return data;
    }
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 3.2 主线程端模板

```typescript
import { Worker } from 'node:worker_threads';

class MainThread extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> {
    return { reply: 'from main', query: data };
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

const worker = new Worker('./worker.js');
const wt = new MainThread(worker);

const result = await wt.request({ action: 'compute', value: 42 }).response();
console.log(result);

wt.dispose();
await worker.terminate();
```

### 3.3 Worker 线程端模板

```typescript
// worker.js
import { MessageWorkerThread } from '@hile/message-worker-thread';
import { Exception } from '@hile/message-modem';

class WorkerThread extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> {
    if (data.action === 'compute') return data.value * 2;
    if (data.action === 'restricted') throw new Exception(403, 'not allowed');
    return data;
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

const wt = new WorkerThread(); // 无参数 → 使用 parentPort
```

### 3.4 MessageChannel 场景模板

```typescript
import { MessageChannel } from 'node:worker_threads';

const { port1, port2 } = new MessageChannel();
const side1 = new MySide1(port1);
const side2 = new MySide2(port2);

// 双向通信
const res = await side1.request('hello').response();
```

### 3.5 强制规则

| 规则 | 说明 |
|------|------|
| **必须继承并实现 `exec`** | `MessageWorkerThread` 是抽象类 |
| **主线程端必须传入 `Worker` 或 `MessagePort`** | `new Worker()` 返回值 |
| **Worker 线程端不传参数** | 自动使用 `parentPort` |
| **用完必须 `dispose()`** | 避免内存泄漏 |
| **主线程还需 `worker.terminate()`** | 关闭 Worker 线程 |

### 3.6 反模式

```typescript
// ❌ 不能直接实例化
const wt = new MessageWorkerThread(worker); // abstract

// ✅ 继承并实现 exec，自行暴露 _send
class MyWT extends MessageWorkerThread {
  protected async exec(data: any) { return data; }
  public request<T = any>(data: T, timeout?: number) { return this._send(data, timeout); }
}

// ❌ Worker 线程里传入 Worker 实例没有意义
const wt = new MyWT(someWorker); // Worker 线程里没有子 Worker

// ✅ Worker 线程不传参数
const wt = new MyWT();

// ❌ 忘记 dispose 和 terminate
// ✅ 清理
wt.dispose();
await worker.terminate();
```
