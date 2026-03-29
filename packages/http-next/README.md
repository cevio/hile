# @hile/http-next

将 Next.js 作为渲染引擎嵌入 `@hile/http`（Koa + find-my-way）的桥接层，共享同一 HTTP 服务。

## 安装

```bash
pnpm add @hile/http-next
```

## 快速开始

```typescript
import HttpNext from "@hile/http-next";

const httpNext = new HttpNext({
  port: 3000,
  cwd: __dirname,       // 项目根目录
  publicPath: "public",  // 静态资源目录
});

const close = await httpNext.start();
// close() 可关闭服务
```

### 与 @hile/core 集成

```typescript
import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService('http.next', async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, ".."),
    publicPath: "public",
  });
  shutdown(await httpNext.start());
  return httpNext;
});
```

## 工作原理

`HttpNext` 在一个 HTTP 服务上同时运行 Koa 路由和 Next.js：

```
Request → Koa 中间件 → koa-static → hile-http 路由(/-*) → Next.js handler
```

- **Next.js App Router**：处理页面渲染（`src/app/page.tsx` 等）
- **hile-http 控制器**：处理 API 路由，自动加载 `*.controller.ts`，前缀固定为 `/-`

两者共存互不冲突。

## API 路由（控制器）

在 `src/app/` 下创建 `*.controller.ts` 文件，使用 `@hile/http` 的 `defineController`：

```typescript
// src/app/post.controller.ts → GET /-/post
import { defineController } from "@hile/http";

export default defineController("GET", async (ctx) => {
  return { id: 1, title: "Hello" };
});
```

### 路径映射

| 文件路径 | HTTP 路由 |
|---------|----------|
| `src/app/post.controller.ts` | `/-/post` |
| `src/app/users/index.controller.ts` | `/-/users` |
| `src/app/users/[id].controller.ts` | `/-/users/:id` |

> 所有控制器路由强制挂载到 `/-` 前缀下，避免与 Next.js 文件路由冲突。

## API

### `HttpNextProps`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|-------|------|
| `port` | `number` | — | 监听端口（必填） |
| `cwd` | `string` | `process.cwd()` | 项目根目录 |
| `publicPath` | `string` | — | 静态资源目录（相对于 cwd） |
| `keys` | `string[]` | — | Koa 签名密钥 |

### `HttpNext`

| 属性 / 方法 | 说明 |
|------------|------|
| `use(middleware)` | 注册 Koa 中间件，返回当前实例以支持链式调用 |
| `start()` | 启动服务，返回 `Promise<() => void>` 关闭函数 |

### `start()` 执行流程

1. 注册 `publicPath` 与 `.next/static` 静态资源（构造函数与 start 内）
2. 加载 `src/app/`（开发）或 `dist/app/`（生产）下的 `*.controller.ts` 路由，挂载到 `/-` 前缀
3. 启动 HTTP 服务（`http.listen()`）
4. 在 `onListen` 回调中：创建 Next 应用并 `prepare()`，挂载 Next.js 转发中间件

## 项目结构

```
my-app/
├── public/                  # 静态资源
├── src/
│   ├── app/
│   │   ├── layout.tsx       # Next.js 根布局
│   │   ├── page.tsx         # Next.js 首页
│   │   ├── about/
│   │   │   └── page.tsx     # Next.js /about 页
│   │   └── post.controller.ts  # API: GET /-/post
│   └── index.boot.ts        # 服务启动入口
├── next.config.mjs
├── tsconfig.json             # Node.js 编译
└── tsconfig.next.json        # Next.js 编译
```

## License

MIT
