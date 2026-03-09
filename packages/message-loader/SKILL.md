---
name: message-loader
description: Code generation and contribution rules for @hile/message-loader. Use when editing this package or when the user asks about @hile/message-loader patterns or API.
---

# @hile/message-loader

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/message-loader` 是一个 **基于文件系统的消息路由加载器**，将目录结构映射为路由表，实现请求/分发模式的消息处理。

它与 `@hile/http` 的 `Loader` 类似，但面向消息通信场景（WebSocket、IPC、Worker Threads 等），而非 HTTP 请求。

核心流程：

```
文件系统                        路由表                       分发
  messages/                    ┌──────────────────────┐
  ├── index.msg.ts    ──────►  │ /                    │
  ├── hello.msg.ts    ──────►  │ /hello               │  ──► dispatch(url, data)
  ├── users/                   │                      │       找到路由 → 执行 fn
  │   ├── index.msg.ts ─────►  │ /users               │       未找到  → 抛出错误
  │   └── [id].msg.ts  ─────►  │ /users/:id           │
  └── ...                      └──────────────────────┘
```

关键设计：

- **文件系统即路由** — `*.msg.{ts,js,tsx,jsx}` 文件自动注册为消息路由
- **index 折叠** — `users/index.msg.ts` 映射为 `/users`
- **动态参数** — `[id].msg.ts` 转换为 `:id`，参数通过 `ctx.params` 传递
- **路径前缀** — 可通过 `prefix` 添加统一前缀（如 `/-`）
- **注销支持** — `load()` 返回注销函数，调用后移除所有已注册路由
- **底层路由** — 使用 `rou3` 作为路由匹配引擎

---

## 2. 类型签名

```typescript
import { MessageLoader, defineMessage, type MessageLoaderProps, type MessageRegisterProps, type MessageFunction } from '@hile/message-loader';

interface MessageLoaderProps {
  suffix?: string;         // 文件后缀标记，默认 'msg'
  defaultSuffix?: string;  // 折叠后缀，默认 '/index'
  prefix?: string;         // 路径前缀，默认 ''
}

type MessageFunction = (data: {
  params?: Record<string, string>;
  data: any;
  url: string;
}) => any;

interface MessageRegisterProps {
  id: number;
  fn: MessageFunction;
}

class MessageLoader {
  constructor(props: MessageLoaderProps);
  load(directory: string): Promise<() => void>;
  dispatch(path: string, data: any): Promise<any>;
}

function defineMessage(fn: MessageFunction): MessageRegisterProps;
```

---

## 3. 代码生成模板与规则

### 3.1 消息处理器模板

每个 `*.msg.ts` 文件需要 `export default` 一个 `MessageRegisterProps` 对象，推荐使用 `defineMessage` 工厂函数：

```typescript
// messages/hello.msg.ts
import { defineMessage } from '@hile/message-loader';

export default defineMessage(async ({ data, params, url }) => {
  return { greeting: `Hello, ${data.name}!` };
});
```

### 3.2 动态参数模板

```typescript
// messages/users/[id].msg.ts
import { defineMessage } from '@hile/message-loader';

export default defineMessage(async ({ params, data }) => {
  const user = await db.findUser(params!.id);
  return user;
});
```

### 3.3 加载器初始化模板

```typescript
import { MessageLoader } from '@hile/message-loader';
import path from 'node:path';

const loader = new MessageLoader({
  suffix: 'msg',
  prefix: '/-',
});

await loader.load(path.resolve(__dirname, 'messages'));
const result = await loader.dispatch('/-/hello', { name: 'world' });
```

### 3.4 与 message-ws 搭配模板

```typescript
import { MessageWs } from '@hile/message-ws';
import { MessageLoader } from '@hile/message-loader';

const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' });
await loader.load(path.resolve(__dirname, 'messages'));

class AppWs extends MessageWs {
  protected async exec(data: { url: string; data: any }): Promise<any> {
    return loader.dispatch(data.url, data.data);
  }
}
```

### 3.5 强制规则

| 规则 | 说明 |
|------|------|
| **文件必须 `export default`** | 缺少默认导出的文件会被静默跳过 |
| **默认导出必须是 `MessageRegisterProps`** | 推荐使用 `defineMessage()` 创建 |
| **`fn` 接收 `{ params, data, url }` 参数** | `params` 来自路由匹配，`data` 来自调用方 |
| **`dispatch` 返回 Promise** | 即使 `fn` 是同步函数也会被 `Promise.resolve` 包装 |
| **路径未匹配时 `dispatch` 抛出错误** | `Error: message not found: <path>` |
| **`load` 返回注销函数** | 调用后移除所有已注册路由 |

### 3.6 反模式

```typescript
// ❌ 不使用 defineMessage，手动构造对象时遗漏 id
export default { fn: () => 'hello' };

// ✅ 使用 defineMessage 自动分配 id
export default defineMessage(() => 'hello');

// ❌ dispatch 时未 await
const result = loader.dispatch('/hello', data);
console.log(result); // Promise 对象

// ✅ await dispatch 结果
const result = await loader.dispatch('/hello', data);

// ❌ 文件名后缀不匹配 suffix 配置
// suffix 配置为 'msg'，但文件命名为 hello.handler.ts
export default defineMessage(() => 'hello');

// ✅ 文件名后缀与 suffix 一致
// hello.msg.ts
export default defineMessage(() => 'hello');

// ❌ 在 dispatch 时使用错误的路径（未加 prefix）
const loader = new MessageLoader({ prefix: '/-' });
loader.dispatch('/hello', data); // 未找到

// ✅ dispatch 路径需要包含 prefix
loader.dispatch('/-/hello', data);
```
