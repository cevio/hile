# @hile/message-worker-thread

基于 `@hile/message-modem` 的 Node.js Worker Threads 通信抽象实现。让主线程与 Worker 线程之间的请求/响应通信像调用函数一样简单。

## 安装

```bash
pnpm add @hile/message-worker-thread
```

## 核心特性

- **双端支持** — 主线程传入 `Worker` 或 `MessagePort`，Worker 线程端零配置
- **继承模式** — 继承 `MessageWorkerThread` 并实现 `exec` 方法
- **请求/响应** — 继承 `MessageModem` 的全部能力
- **超时控制** — 默认 30 秒，可按请求自定义
- **主动中止** — `abort()` 取消等待并通知对端
- **错误传播** — `Exception` 带 status 透传，普通 Error 映射为 500
- **资源清理** — `dispose()` 移除监听，避免内存泄漏

## 快速开始

### 第一步：定义子类

```typescript
import { MessageWorkerThread } from '@hile/message-worker-thread';
import { Exception } from '@hile/message-modem';

class ComputeWorker extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> {
    switch (data?.action) {
      case 'compute':
        return data.value * 2;
      case 'restricted':
        throw new Exception(403, 'not allowed');
      default:
        return data;
    }
  }
}
```

### 第二步：主线程

```typescript
import { Worker } from 'node:worker_threads';

class MainThread extends MessageWorkerThread {
  protected async exec(data: any): Promise<any> {
    return { reply: 'from main', query: data };
  }
}

const worker = new Worker('./worker.js');
const wt = new MainThread(worker);

const result = await wt.request({ action: 'compute', value: 42 }).response();
console.log(result); // 84

wt.dispose();
await worker.terminate();
```

### 第三步：Worker 线程（worker.js）

```typescript
const wt = new ComputeWorker(); // 无参数 → 自动使用 parentPort
```

## API

### `MessageWorkerThread`（抽象类）

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `new SubClass(port?: Worker \| MessagePort)` | 主线程传 Worker/MessagePort；Worker 线程不传参数 |
| `exec` | `protected abstract exec(data: any): Promise<any>` | 子类实现：处理对端请求 |
| `request` | `request<T>(data: T, timeout?: number)` | 向对端发送请求，返回 `{ abort, response }` |
| `dispose` | `dispose(): void` | 移除消息监听，释放资源 |

### `request` 返回值

| 属性 | 类型 | 说明 |
|------|------|------|
| `abort` | `() => void` | 中止请求 |
| `response` | `<U>() => Promise<U>` | 等待对端响应 |

## 也可以用 MessageChannel

```typescript
import { MessageChannel } from 'node:worker_threads';

const { port1, port2 } = new MessageChannel();
const side1 = new MySide(port1);
const side2 = new MySide(port2);

const result = await side1.request('hello').response();
```

## 超时与中止

```typescript
import { AbortException, Exception } from '@hile/message-modem';

// 5 秒超时
const result = await wt.request(data, 5000).response();

// 主动中止
const req = wt.request(data);
setTimeout(() => req.abort(), 3000);
try {
  await req.response();
} catch (e) {
  if (e instanceof AbortException) {
    console.log('请求被中止或超时');
  } else if (e instanceof Exception) {
    console.log(`远端错误 [${e.status}]: ${e.message}`);
  }
}
```

## 注意事项

- `MessageWorkerThread` 是 **抽象类**，不能直接实例化
- Worker 线程端不传参数时，必须在 Worker 线程内运行（`parentPort` 可用）
- 使用完毕后务必 `dispose()` + `worker.terminate()`

## License

MIT
