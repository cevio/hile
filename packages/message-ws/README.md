# @hile/message-ws

基于 `@hile/message-modem` 和 `ws` 模块的 WebSocket 通信抽象实现。让客户端与服务端之间的请求/响应通信像调用函数一样简单。

## 安装

```bash
pnpm add @hile/message-ws
```

## 核心特性

- **双端支持** — 客户端和服务端各自包装 `WebSocket` 实例即可
- **继承模式** — 继承 `MessageWs` 并实现 `exec` 方法
- **JSON 传输** — 消息自动 JSON 序列化/反序列化
- **请求/响应** — 继承 `MessageModem` 全部能力
- **超时控制** — 默认 30 秒，可按请求自定义
- **主动中止** — `abort()` 取消等待并通知对端
- **错误传播** — `Exception` 带 status 透传，普通 Error 映射为 500
- **连接状态检查** — 发送前检查 `readyState`
- **资源清理** — `dispose()` 移除监听

## 快速开始

### 第一步：定义子类

```typescript
import { MessageWs } from '@hile/message-ws';
import { Exception } from '@hile/message-modem';

class AppWs extends MessageWs {
  protected async exec(data: any): Promise<any> {
    switch (data?.action) {
      case 'getUser':
        return { id: data.id, name: 'Alice' };
      case 'restricted':
        throw new Exception(403, 'not allowed');
      default:
        return data;
    }
  }
}
```

### 第二步：服务端

```typescript
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: 8080 });
wss.on('connection', (ws) => {
  const modem = new AppWs(ws);
  // 自动处理客户端请求
});
```

### 第三步：客户端

```typescript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8080');
ws.on('open', () => {
  const modem = new AppWs(ws);

  const user = await modem.request({ action: 'getUser', id: 1 }).response();
  console.log(user); // { id: 1, name: 'Alice' }

  modem.dispose();
  ws.close();
});
```

## API

### `MessageWs`（抽象类）

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `new SubClass(ws: WebSocket)` | 传入已连接的 WebSocket 实例 |
| `exec` | `protected abstract exec(data: any): Promise<any>` | 子类实现：处理对端请求 |
| `request` | `request<T>(data: T, timeout?: number)` | 向对端发送请求，返回 `{ abort, response }` |
| `dispose` | `dispose(): void` | 移除消息监听，释放资源 |

### `request` 返回值

| 属性 | 类型 | 说明 |
|------|------|------|
| `abort` | `() => void` | 中止请求 |
| `response` | `<U>() => Promise<U>` | 等待对端响应 |

## 超时与中止

```typescript
import { AbortException, Exception } from '@hile/message-modem';

// 5 秒超时
const result = await modem.request(data, 5000).response();

// 主动中止
const req = modem.request(data);
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

- `MessageWs` 是 **抽象类**，不能直接实例化
- 必须在 WebSocket 连接建立（`open` 事件）后再创建实例或发送请求
- 消息通过 JSON 序列化传输，不支持 Buffer/Map/Set 等非 JSON 类型
- 使用完毕后调用 `dispose()` + `ws.close()`

## License

MIT
