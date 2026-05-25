---
name: hile
description: "Hile 代码生成规范。当编辑/生成涉及 @hile/* 或 create-hile 时必读。包含各包的具体用法示例、目录约定、生命周期写法。适用于：新增 API 路由、数据库/缓存接入、消息通信、微服务注册发现、HTTP+Next.js 同端口项目。"
---

# Hile monorepo — 统一代码生成规范

本文档是**代码生成指南**，不是抽象参考。当你需要编写或修改使用 `@hile/*` 的代码时，按场景查阅对应章节，直接使用其中的示例模板。

---

## 核心概念（所有包通用）

**服务容器（`@hile/core`）**是整个框架的基石：
- `defineService(key, fn)` —— 定义服务（注册到容器但不执行）
- `loadService(service)` —— 获取服务实例（首次调用时执行 fn，之后返回缓存单例）
- `shutdown(fn)` —— 在服务函数内注册清理回调（LIFO 顺序）

**Boot 机制（`@hile/cli`）**：
- `src/services/*.boot.ts` —— 由 `hile start` **自动扫描加载**的服务入口
- `src/services/*.service.ts` —— **依赖加载**的服务，在 boot/其他服务/model 内通过 `loadService` 按需加载
- `package.json` 的 `hile.auto_load_packages` —— 声明模块名（非文件路径），在 boot 扫描前自动加载

---

## 一、包速查表（按场景选包）

| 你要做什么 | 用哪个包 | 关键导出 |
|-----------|---------|---------|
| 定义异步单例服务、管理生命周期 | `@hile/core` | `defineService` / `loadService` / `isService` / `container` |
| 启动应用、扫描 boot 文件 | `@hile/cli` | CLI `hile start` |
| HTTP API（Koa + 路由） | `@hile/http` | `Http` / `defineController` / `Loader` / `defineResponsePlugin` |
| API + Next.js 同端口 | `@hile/http-next` | `HttpNext` |
| 数据库操作 | `@hile/typeorm` | `transaction` / 默认导出 DataSource 服务 |
| Redis 缓存 | `@hile/ioredis` | 默认导出 Redis 客户端服务 |
| 带模板参数的 Redis 缓存键 | `@hile/cache` | `defineCache` / `RedisCache` |
| 请求/响应消息抽象（超时、中止） | `@hile/message-modem` | `MessageModem`（抽象类，需实现 post/exec） |
| 父子进程 IPC | `@hile/message-ipc` | `MessageIpc`（抽象类） |
| Worker 线程通信 | `@hile/message-worker-thread` | `MessageWorkerThread`（抽象类） |
| WebSocket 通信 | `@hile/message-ws` | `MessageWs`（抽象类） |
| 文件系统消息路由 | `@hile/message-loader` | `MessageLoader` / `defineMessage` |
| 微服务注册发现（WS） | `@hile/micro` | `Server` / `Client` / `Registry` / `Application` |
| 动态配置（ZK-like） | `@hile/micro-dynamic-configs` | `MicroDynamicConfigsServer` |
| 业务数据管线（中间件链） | `@hile/model` | `defineModel` / `loadModel` / `Pipeline` |
| 创建新 Hile 项目 | `create-hile` | CLI `create-hile create <name>` |

---

## 二、@hile/core — 服务容器

### 定义并加载一个服务

```typescript
// src/services/redis.service.ts — 依赖加载的服务
import { defineService, loadService } from '@hile/core';

export default defineService('my-redis', async (shutdown) => {
  const client = new Redis(/* ... */);
  await client.connect();
  
  // 必须在创建外部资源后立即注册清理
  shutdown(() => client.disconnect());
  
  return client;
});
```

```typescript
// src/services/http.boot.ts — 自启动入口（由 CLI 扫描加载）
import { defineService, loadService } from '@hile/core';
import { Http } from '@hile/http';
import httpService from './http.service.js'; // 按需加载其他服务

export default defineService('my-http', async (shutdown) => {
  const http = new Http({ port: 3000 });
  http.get('/hello', async (ctx) => { ctx.body = 'world'; });
  const close = await http.listen();
  shutdown(() => close());
});
```

### 在服务内部获取其他服务

```typescript
// 不要在模块顶层 await loadService()
export default defineService('worker', async (shutdown) => {
  // 在服务函数内部加载
  const ds = await loadService(typeormService);
  const redis = await loadService(redisService);
  // ...
});
```

### 生命周期速查

| 阶段 | 状态 | 说明 |
|------|------|------|
| 注册 | — | `defineService` 不执行，只是注册 |
| 第一次 `loadService` | `init -> ready` | 执行工厂函数，返回结果，后续调用缓存 |
| 启动失败 | `init -> stopping -> stopped` | 自动执行已注册的 shutdown，然后清除队列 |
| `container.shutdown()` | 逆序 LIFO | 后启动的服务先关闭；循环清空直到队列为空 |

---

## 三、@hile/http — HTTP API

### 定义控制器

```typescript
// src/controllers/user.controller.ts
// export default 一个 defineController 或数组
import { defineController } from '@hile/http';

// 简单形式：method + handler
export default defineController('GET', async (ctx) => {
  return { list: [] };
});

// 带中间件
export default defineController('POST', [authMiddleware], async (ctx) => {
  return { success: true };
});

// 带 Zod 校验
import { z, createControllerMetadata, defineController } from '@hile/http';

export default defineController(
  createControllerMetadata({
    method: 'POST',
    schema: {
      body: z.object({ name: z.string(), age: z.number() }),
    },
  }),
  async (ctx) => {
    // ctx.request.body 已被 Zod 校验过
    return { result: ctx.request.body.name };
  },
);

// 文件路径转换为路由：
//   src/controllers/user.controller.ts        → GET /user
//   src/controllers/user/index.controller.ts  → GET /user
//   src/controllers/user/[id].controller.ts   → GET /user/:id
```

### 创建并启动 Http 服务（boot 中）

```typescript
// src/services/http.boot.ts
import { defineService } from '@hile/core';
import { Http } from '@hile/http';

export default defineService('http', async (shutdown) => {
  const http = new Http({ port: 3000 });
  
  http.use(async (ctx, next) => {
    const start = Date.now();
    await next();
    console.log(`${ctx.method} ${ctx.url} ${Date.now() - start}ms`);
  });
  
  // 从目录加载所有 controller 文件
  // 默认后缀 'controller'，路由冲突策略 error
  await http.load('./src/controllers', { suffix: 'controller', defaultSuffix: '/index' });
  
  const close = await http.listen();
  shutdown(() => close());
});
```

### 响应插件

```typescript
import { defineResponsePlugin } from '@hile/http';

defineResponsePlugin(async (ctx, result, next) => {
  // 对所有响应结果进行后处理
  const processed = result !== undefined ? { code: 0, data: result } : undefined;
  return next(processed);
});
```

### 路由冲突策略

`Loader` 支持三种冲突策略：
- `'error'`（默认）—— 重复路由直接抛错
- `'warn'` —— 打印警告，保留已注册的路由
- `'override'` —— 注销旧路由，注册新路由

---

## 四、@hile/http-next — HTTP + Next.js 同端口

### 标准项目目录结构

```
project/
├── src/
│   ├── app/               # Next.js App Router 页面
│   │   ├── page.tsx
│   │   └── ... 
│   ├── controllers/       # API 控制器（默认前缀 /-）
│   │   └── user.controller.ts    →  GET /-/user
│   ├── models/            # 业务逻辑（defineModel 唯一位置）
│   │   ├── user/
│   │   │   └── user.model.ts
│   │   └── ...
│   └── services/          # 基础设施服务
│       ├── http.boot.ts   # HttpNext 启动入口
│       └── ...
├── next.config.ts
└── package.json
```

### HttpNext boot 模板

```typescript
// src/services/http.boot.ts
import { defineService } from '@hile/core';
import { HttpNext } from '@hile/http-next';

export default defineService('http', async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, '../..'),  // 重要：boot 在 services/ 下，多一层
  });
  
  const stop = await httpNext.start();
  shutdown(() => stop());
});
```

### 请求处理流程（静态 → API → Next）

```
HTTP Request
  → Koa 中间件链
  → koa-static（`public/` 目录）
  → @hile/http 路由（默认前缀 /-）
  → Next.js 请求处理器（页面渲染）
```

### Model 层规范（重要）

```typescript
// src/models/user/user.model.ts
// defineModel 只能在 src/models/ 下使用
import { defineModel } from '@hile/model';

export default defineModel(async (userId: string) => {
  return { id: userId, name: 'Alice' };
});

// src/app/user/page.tsx 中使用
import { loadModel } from '@hile/model';
import userModel from '@/models/user/user.model';

// 只要 page.tsx 用了 loadModel，必须导出 dynamic
export const dynamic = 'force-dynamic';

export default async function UserPage() {
  const user = await loadModel(userModel, '1');
  return <div>{user.name}</div>;
}
```

---

## 五、@hile/typeorm — 数据库

### 接入方式

```json
// package.json
{
  "hile": {
    "auto_load_packages": ["@hile/typeorm"]
  }
}
```

环境变量：`TYPEORM_TYPE` / `TYPEORM_HOST` / `TYPEORM_USERNAME` / `TYPEORM_PASSWORD` / `TYPEORM_DATABASE` / `TYPEORM_PORT` / `TYPEORM_ENTITIES` / `TYPEORM_SYNCHRONIZE`

### 在服务中使用

```typescript
import { loadService } from '@hile/core';
import typeormService from '@hile/typeorm';

const ds = await loadService(typeormService);
```

### 事务与补偿回调

```typescript
import { transaction } from '@hile/typeorm';

await transaction(ds, async (runner, rollback) => {
  const user = await runner.manager.save(User, { name: 'Alice' });
  
  // 注册补偿：事务失败时 LIFO 执行
  rollback(async () => {
    // 例如：清理缓存，发送回滚通知等
    await cache.del(`user:${user.id}`);
  });
  
  await runner.manager.save(Log, { action: 'create_user', userId: user.id });
  return user;
});
// 成功 → commitTransaction；失败 → rollbackTransaction + 执行补偿队列
```

---

## 六、@hile/ioredis — Redis

```json
// package.json
{
  "hile": {
    "auto_load_packages": ["@hile/ioredis"]
  }
}
```

环境变量：`REDIS_HOST` / `REDIS_PORT` / `REDIS_USERNAME` / `REDIS_PASSWORD` / `REDIS_DB`

```typescript
import { loadService } from '@hile/core';
import redisService from '@hile/ioredis';

const redis = await loadService(redisService);
await redis.set('key', 'value');
await redis.get('key');
```

---

## 七、@hile/cache — 缓存键声明

```typescript
import { defineCache, RedisCache } from '@hile/cache';

// 声明带类型参数的缓存键
const userCache = defineCache('user:{id:string}:{x:number}', async (params) => {
  // params.id: string, params.x: number
  const data = await fetchUser(params.id);
  return new Cache(data).setExpire(60); // TTL 60秒
});

// 使用
const cache = new RedisCache('my-prefix:');
const { read, write, remove, has } = await cache.loadCache(userCache);

await read({ id: 'abc', x: 42 });     // 读（未命中则自动写穿透）
await write({ id: 'abc', x: 42 });     // 写
await remove({ id: 'abc', x: 42 });    // 删
await has({ id: 'abc', x: 42 });       // 是否存在
```

---

## 八、消息通信体系

### 架构层级

```
@hile/message-modem（抽象基类：请求/响应/中止/流）
  ├── @hile/message-ipc（父子进程）
  ├── @hile/message-worker-thread（Worker 线程）
  └── @hile/message-ws（WebSocket）
        └── @hile/message-loader（文件系统路由）
              └── @hile/micro（服务发现）
```

### MessageModem — 实现自定义通信层

```typescript
import { MessageModem, MessageTransferFormat } from '@hile/message-modem';

class MyModem extends MessageModem {
  protected post(data: MessageTransferFormat): void {
    // 如何发送数据到远端
    transport.send(JSON.stringify(data));
  }
  protected async exec(data: any, signal?: AbortSignal): Promise<any> {
    // 如何处理收到的请求；流式请求必须返回 AsyncIterable
    return processData(data);
  }
}

const modem = new MyModem();
// 双向请求：返回 Promise<响应数据>
const res = await modem._send({ url: '/hello', data: 'world' });
// 带超时和取消信号
const res2 = await modem._send({ url: '/slow' }, { timeout: 5000, signal: abortSignal });

modem._push({ url: '/log', data: 'info' });                       // 单向推送
modem._push({ url: '/log', data: 'info' }, { timeout: 1000 });    // 带超时的推送

const stream = modem._stream({ url: '/events' });                 // 流式读取（返回 Readable）
for await (const chunk of stream) {
  console.log('chunk:', chunk);
}
```

### MessageLoader — 文件系统消息路由

```typescript
// src/messages/ping.msg.ts —— 普通请求-响应
import { defineMessage } from '@hile/message-loader';
export default defineMessage(async ({ params, data }) => {
  return { type: 'pong', timestamp: Date.now() };
});

// src/messages/events.msg.ts —— 流式响应（async function* 返回 AsyncIterable）
export default defineMessage(async function* ({ params, data }) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 100));
    yield { value: data.query, index: i };  // seq 由 MessageModem 自动生成
  }
});

// 路由映射：src/messages/ping.msg.ts → /ping, events.msg.ts → /events

// 加载并分发
import { MessageLoader } from '@hile/message-loader';
const loader = new MessageLoader({ suffix: 'msg', prefix: '/-' });
const unload = await loader.load('./src/messages'); // 返回取消加载函数

// 普通调用
const result = await loader.dispatch('/-/ping', { /* data */ });

// 流式调用：dispatch 返回 AsyncIterable
const stream = await loader.dispatch('/-/events', { query: 'test' });
for await (const chunk of stream) {
  console.log('chunk:', chunk);
}
```

---

## 九、@hile/micro — 微服务

### Registry（注册中心）

```typescript
import { Registry } from '@hile/micro';
const registry = new Registry();
await registry.listen(9876);  // 启动 WebSocket 注册中心
```

### Application（服务提供者 + 消费者）

Provider 侧推荐使用**文件系统路由**，将消息处理器放在 `*.msg.ts` 文件中，通过 `app.load()` 自动加载：

```typescript
// src/messages/hello.msg.ts —— 消息处理器文件
import { defineMessage } from '@hile/message-loader';
export default defineMessage(async ({ params, data }) => {
  return `hello ${data.name}`;
});
// 文件路径 → 路由：src/messages/hello.msg.ts → /hello

// src/messages/events.msg.ts —— 流式消息处理器
export default defineMessage(async function* ({ params, data }) {
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 500));
    yield { value: data.type, index: i };  // seq 由 MessageModem 自动生成
  }
});
// 文件路径 → 路由：src/messages/events.msg.ts → /events（与 app.stream 配对使用）
```

```typescript
// src/services/app.boot.ts —— 启动入口
import { Application } from '@hile/micro';
import { resolve } from 'node:path';

const app = new Application({
  namespace: 'my-service',
  registry: { host: '127.0.0.1', port: 9876 },
});

// 从文件系统加载所有消息处理器（推荐方式）
await app.load(resolve(__dirname, '../messages'));

// 调用其他服务（consumer 侧）
const result = await app.call('other-service', '/hello', { name: 'world' });

// 带超时和重试的调用（options 对象）
const result2 = await app.call('other-service', '/slow', { data: 1 }, {
  timeout: 5000,    // 超时，默认继承 Application 的 requestTimeoutMs
  retries: 0,       // 重试次数，默认 1
  signal: abortSignal, // 可取消
});

// 流式调用：适用于大结果集或 SSE（返回 Node.js Readable stream，可用 for await...of）
const stream = await app.stream('other-service', '/events', { type: 'user-updates' });
for await (const chunk of stream) {
  console.log('received:', chunk);
}
// stream 也支持 options：{ retries?, signal? }
const stream2 = await app.stream('other-service', '/events', { type: 'test' }, { retries: 2 });

// Pub/Sub —— 跨服务事件广播
// 同一 registry 下所有同 namespace 的服务实例都能收到订阅的事件
// publish 不会等待 subscriber 处理完成，但返回对象可用于管理该事件
const event = await app.publish('order.created', { orderId: 1, amount: 99 });

// event.update(data) —— 推送更新（同事件名，新数据）
await event.update({ orderId: 1, amount: 199 });

// event.unpublish() —— 下线该事件，后续 subscriber 不再收到
await event.unpublish();

// subscribe 监听事件，返回取消订阅函数
const unsubscribe = app.subscribe('order.created', (data) => {
  console.log('order created:', data.orderId, data.amount);
});
// 调用 unsubscribe() 取消订阅
unsubscribe();

await app.listen(3001);
```

如确需编程式注册，`app.register(path, fn)` 也可用（返回注销函数），但 `app.load()` 更利于目录组织与路由分离。

### 熔断与重试

`Application.call()` 和 `Application.stream()` 内置了：
- **熔断器**：连续失败的节点在 30 秒冷却期内被排除
- **自动重试**：默认 1 次重试，失败后尝试其他节点
- **缓存降级**：Registry 不可用时，使用上一次成功的节点缓存

---

## 十、@hile/model — 业务管线

```typescript
import { defineModel, loadModel, Pipeline } from '@hile/model';
import typeormService from '@hile/typeorm';
import redisService from '@hile/ioredis';

// 定义：含服务依赖 + 管线 + 主逻辑
export default defineModel({
  services: [typeormService, redisService], // 自动 resolve
  pipelines: [async (ctx, next) => {
    console.log('before:', ctx.args);
    await next();
    console.log('after');
  }],
  main: async ([ds, redis], input: { id: string }) => {
    const user = await ds.manager.findOne(User, { where: { id: input.id } });
    return user;
  },
});

// 消费：每次 loadModel 都重新执行 main
const result = await loadModel(userModel, { id: '1' });

// 简写形式（无 services / pipelines）
export default defineModel(async (input: { id: string }) => {
  return { id: input.id };
});
```

---

## 十一、create-hile — 创建项目

```bash
npx create-hile create my-project
# 选择模板：default / next / micro-http / micro / micro-http-next / monorepo
cd my-project && pnpm install && pnpm run dev
```

模板类型：
- `default` —— 纯 HTTP（Koa + @hile/http）
- `next` —— Next.js + @hile/http-next
- `micro-http` —— 微服务 + HTTP（无 Next）
- `micro` —— 纯微服务
- `micro-http-next` —— Next.js + 微服务 + HTTP（全栈）
- `monorepo` —— Lerna + pnpm workspace

---

## 十二、常见反模式（禁止）

```typescript
// ❌ 模块顶层 await loadService
import service from './service.js';
const instance = await loadService(service); // 禁止

// ❌ boot 文件 export default 普通函数
export default async () => { ... }; // 禁止：必须 defineService 返回值

// ❌ 控制器同时写 ctx.body 和 return
export default defineController('GET', async (ctx) => {
  ctx.body = { x: 1 }; // 禁止：只 return
  return { x: 1 };
});

// ❌ 控制器签名为 (ctx, next)
export default defineController('GET', async (ctx, next) => { // 禁止
  await next();
});

// ❌ boot 文件放在 src/services/ 外
// src/index.boot.ts  →  禁止

// ❌ auto_load_packages 写文件路径
{ "hile": { "auto_load_packages": ["./src/services/db.service.ts"] } }  // 禁止：必须是模块名

// ❌ http-next 的 src/app/ 下用 loadService
// 禁止：src/app/ 只允许 loadModel

// ❌ http-next 的 src/app/ 下定义 model
// 禁止：defineModel 只在 src/models/

// ❌ 将基础设施放在 src/models/，业务逻辑放在 src/services/
```

---

## 十三、快速参考：在什么文件里用什么 API

| 文件 | 允许的导入 |
|------|-----------|
| `src/services/*.boot.ts` | `defineService`, `loadService`, `loadModel` |
| `src/services/*.service.ts` | `defineService`, `loadService`, `loadModel` |
| `src/models/*.model.ts` | `defineModel`, `loadService`, `loadModel`（可组合其他模型） |
| `src/controllers/*.controller.ts`（http-next） | `defineController`, `loadService`, `loadModel` |
| `src/app/**/page.tsx`（http-next） | `loadModel`（仅配合 `src/models` 导出的 model） |
| `src/app/**/layout.tsx`（http-next） | `loadModel` 可选（不强制 `force-dynamic`） |

---

## 十四、文件命名约定速查

| 后缀 | 类型 | 加载方式 | 位置约束 |
|------|------|---------|---------|
| `*.boot.ts` / `*.boot.js` | 服务入口（自启动） | CLI 自动扫描 | `src/services/` |
| `*.service.ts` / `*.service.js` | 服务（依赖加载） | `loadService` | `src/services/` |
| `*.model.ts` / `*.model.js` | 业务模型 | `loadModel` | `src/models/` |
| `*.controller.ts` / `*.controller.js` | HTTP 控制器 | `http.load()` 扫描 | 默认 `src/controllers/` |
| `*.msg.ts` / `*.msg.js` | 消息处理器 | `loader.load()` 扫描 | 自定义（如 `src/messages/`） |
