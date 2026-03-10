# @hile/message-ipc

基于 `@hile/message-modem` 的 Node.js IPC 通信抽象实现。让父子进程间的请求/响应通信像调用函数一样简单。

## 安装

```bash
pnpm add @hile/message-ipc
```

## 核心特性

- **双端支持** — 父进程端传入 `ChildProcess`，子进程端零配置
- **继承模式** — 继承 `MessageIpc` 并实现 `exec` 方法定义请求处理逻辑
- **请求/响应** — 继承 `MessageModem` 的全部能力
- **超时控制** — 默认 30 秒，可按请求自定义
- **主动中止** — `abort()` 取消等待并通知对端
- **错误传播** — `Exception` 带 status 透传，普通 Error 映射为 500
- **资源清理** — `dispose()` 移除监听，避免内存泄漏

## 快速开始

### 第一步：定义子类

`MessageIpc` 是抽象类，需继承并实现 `exec` 方法：

```typescript
import { MessageIpc } from '@hile/message-ipc';
import { Exception } from '@hile/message-modem';

class WorkerIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> {
    switch (data?.action) {
      case 'compute':
        return data.value * 2;
      case 'restricted':
        throw new Exception(403, 'not allowed');
      default:
        return data; // echo
    }
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}
```

### 第二步：父进程

```typescript
import { fork } from 'node:child_process';

class ParentIpc extends MessageIpc {
  protected async exec(data: any): Promise<any> {
    return { reply: 'from parent', query: data };
  }

  public request<T = any>(data: T, timeout?: number) {
    return this._send(data, timeout);
  }
}

const child = fork('./worker.js');
const ipc = new ParentIpc(child);

const result = await ipc.request({ action: 'compute', value: 42 }).response();
console.log(result); // 84

ipc.dispose();
child.kill();
```

### 第三步：子进程（worker.js）

```typescript
const ipc = new WorkerIpc(); // 无参数 → 自动使用 process
```

## API

### `MessageIpc`（抽象类）

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `new SubClass(channel?: ChildProcess)` | 父进程传 `fork()` 返回值；子进程不传参数 |
| `exec` | `protected abstract exec(data: any): Promise<any>` | 子类实现：处理对端请求的业务逻辑 |
| `_send` | `protected _send<T>(data: T, timeout?: number)` | 发送双向请求（`twoway: true`），返回 `{ abort, response }`。子类自行暴露为 public |
| `_push` | `protected _push<T>(data: T, timeout?: number)` | 发送单向推送（`twoway: false`），接收方不回复 RESPONSE |
| `dispose` | `dispose(): void` | 移除消息监听，释放资源 |

### `_send` 返回值

| 属性 | 类型 | 说明 |
|------|------|------|
| `abort` | `() => void` | 中止请求 |
| `response` | `<U>() => Promise<U>` | 等待对端响应 |

## 超时与中止

```typescript
import { AbortException, Exception } from '@hile/message-modem';

// 5 秒超时
const result = await ipc.request(data, 5000).response();

// 主动中止
const req = ipc.request(data);
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

- `MessageIpc` 是 **抽象类**，不能直接实例化，必须继承并实现 `exec`
- 子进程必须通过 `fork()` 启动，`spawn()` 没有 IPC 通道
- 使用完毕后务必调用 `dispose()` + `child.kill()` 清理资源

## License

MIT
