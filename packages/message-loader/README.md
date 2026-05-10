# @hile/message-loader

基于文件系统的消息路由加载器。将目录结构自动映射为路由表，实现请求/分发模式的消息处理。适用于 WebSocket、IPC、Worker Threads 等消息通信场景。

## 安装

```bash
pnpm add @hile/message-loader
```

## 核心特性

- **文件系统即路由** — `*.msg.{ts,js,tsx,jsx}` 文件自动注册为消息路由
- **index 折叠** — `users/index.msg.ts` 映射为 `/users`
- **动态参数** — `[id].msg.ts` 转换为 `:id`，参数通过处理器入参的 **`params`** 字段传递
- **路径前缀** — 通过 `prefix` 添加统一前缀
- **编程式注册** — `register(routePath, fn)` 在运行时挂路由，返回单条注销函数
- **`dispatch` 扩展字段** — `dispatch(path, data, extras?)` 会将 `extras` 展开合并到处理器入参（如 `@hile/micro` 传入 `{ client }`）
- **注销支持** — `load()` 返回注销函数，调用后移除所有已注册路由；`register()` 返回单条路由的注销函数
- **传输无关** — 可搭配 `@hile/message-ws`、`@hile/message-ipc`、`@hile/message-worker-thread`、`@hile/micro` 等使用

## 快速开始

### 第一步：定义消息处理器

每个消息处理器是一个 `*.msg.ts` 文件，通过 `defineMessage` 创建：

```typescript
// messages/hello.msg.ts
import { defineMessage } from '@hile/message-loader';

export default defineMessage(async ({ data, params, url }) => {
  return { greeting: `Hello, ${data.name}!` };
});
```

### 第二步：支持动态参数

```typescript
// messages/users/[id].msg.ts
import { defineMessage } from '@hile/message-loader';

export default defineMessage(async ({ params }) => {
  return { userId: params!.id };
});
```

### 第三步：加载并分发

```typescript
import { MessageLoader } from '@hile/message-loader';
import path from 'node:path';

const loader = new MessageLoader({
  suffix: 'msg',       // 文件后缀标记
  prefix: '/-',        // 路径前缀
});

// 加载目录下所有消息处理器
await loader.load(path.resolve(__dirname, 'messages'));

// 分发消息
const result = await loader.dispatch('/-/hello', { name: 'world' });
console.log(result); // { greeting: 'Hello, world!' }

const user = await loader.dispatch('/-/users/42', {});
console.log(user); // { userId: '42' }
```

## 与 message 模块搭配

### 编程式注册（无文件）

与从目录 `load` 并列，可在运行时注册路由：

```typescript
const loader = new MessageLoader({ prefix: '/-' });

const unregister = loader.register('/-/health', async ({ data }) => ({ ok: true, data }));

const out = await loader.dispatch('/-/health', { ping: 1 });
// 调用 unregister() 可移除该路由
```

### 搭配 @hile/message-ws

```typescript
import { MessageWs } from '@hile/message-ws';

class AppWs extends MessageWs {
  protected async exec(data: { url: string; data: any }): Promise<any> {
    return loader.dispatch(data.url, data.data);
  }

  public request(url: string, data: any, timeout?: number) {
    return this._send({ url, data }, timeout);
  }
}
```

### 搭配 @hile/message-worker-thread

```typescript
import { MessageWorkerThread } from '@hile/message-worker-thread';

class AppWorker extends MessageWorkerThread {
  protected async exec(data: { url: string; data: any }): Promise<any> {
    return loader.dispatch(data.url, data.data);
  }

  public request(url: string, data: any, timeout?: number) {
    return this._send({ url, data }, timeout);
  }
}
```

### 搭配 @hile/message-ipc

```typescript
import { MessageIpc } from '@hile/message-ipc';

class AppIpc extends MessageIpc {
  protected async exec(data: { url: string; data: any }): Promise<any> {
    return loader.dispatch(data.url, data.data);
  }

  public request(url: string, data: any, timeout?: number) {
    return this._send({ url, data }, timeout);
  }
}
```

## 文件系统映射规则

| 文件路径 | 路由（无 prefix） | 路由（prefix: `/-`） |
|---------|-------------------|---------------------|
| `index.msg.ts` | `/` | `/-/` |
| `hello.msg.ts` | `/hello` | `/-/hello` |
| `users/index.msg.ts` | `/users` | `/-/users` |
| `users/[id].msg.ts` | `/users/:id` | `/-/users/:id` |
| `[category]/[id].msg.ts` | `/:category/:id` | `/-/:category/:id` |

## API

### `MessageLoader`

| 方法 | 签名 | 说明 |
|------|------|------|
| `constructor` | `new MessageLoader(props: MessageLoaderProps)` | 创建加载器实例 |
| `load` | `load(directory: string): Promise<() => void>` | 从目录加载消息处理器，返回注销函数 |
| `register` | `register(routePath: string, fn: MessageFunction): () => void` | 注册单条路由，返回注销函数 |
| `dispatch` | `dispatch(path: string, data: any, extras?: Record<string, any>): Promise<any>` | 分发消息；`extras` 会合并进处理器入参 |

### `MessageLoaderProps`

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `suffix` | `string` | `'msg'` | 文件后缀标记 |
| `defaultSuffix` | `string` | `'/index'` | 折叠后缀（index 文件映射为父级路径） |
| `prefix` | `string` | `''` | 路径前缀 |

### `defineMessage(fn)`

工厂函数，创建消息处理器注册信息。

```typescript
function defineMessage(fn: MessageFunction): MessageRegisterProps;

type MessageFunction<T = any, E extends Record<string, any> = {}> = (data: {
  params?: Record<string, string>;
  data: T;
  url: string;
} & E) => any;
```

## 注意事项

- 消息处理器文件必须有 `export default`，缺少默认导出的文件会被静默跳过
- `dispatch` 在路径未匹配时会抛出 `NotFoundException`（包含 `status: 'NOT_FOUND'`）
- `dispatch` 返回 Promise，即使处理器是同步函数
- `load()` 返回的注销函数调用后，仅移除**该次 load** 注册的路由；`register()` 注册的路由须用其返回的函数单独注销
- 第三参 `extras` 会与 `{ params, data, url }` 合并传入 `fn`，命名勿与内置键冲突

## License

MIT
