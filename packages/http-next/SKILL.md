---
name: http-next
description: Code generation and contribution rules for @hile/http-next. Use when editing this package or when the user asks about @hile/http-next patterns or API.
---

# @hile/http-next

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

`@hile/http-next` 是 `@hile/http`（Koa + find-my-way）与 Next.js 的桥接层。它将 Next.js 作为渲染引擎嵌入 Koa 服务，同时保留 `@hile/http` 的文件系统路由与中间件能力。

核心职责：

- 创建 Koa HTTP 服务并启动 Next.js（共享同一 `httpServer`）
- 通过 `koa-static` 提供 `public` 与 `.next/static` 的静态资源
- 加载 `*.controller.ts` 文件系统路由，挂载到 `/-` 前缀下
- 将所有未匹配请求转发给 Next.js request handler

请求流向：

```
Request → Koa 中间件 → koa-static → hile-http 路由(/-*) → Next.js handler
```

关键约束：

- **控制器路由必须使用 `/-` 前缀**，避免与 Next.js App Router 文件路由冲突
- 控制器文件放在 `src/app/` 目录下，命名为 `*.controller.ts`
- Next.js 使用独立的 `tsconfig.next.json`，通过 `next.config.mjs` 的 `typescript.tsconfigPath` 指定

---

## 2. 类型签名

```typescript
import type { HttpProps } from "@hile/http";
import type { RequestHandler } from "next/dist/server/next";

export type HttpNextProps = HttpProps & {
  cwd?: string;        // 项目根目录，默认 process.cwd()
  publicPath?: string;  // 静态资源目录（相对于 cwd）
};

export class HttpNext {
  readonly isDevelopment: boolean;
  readonly cwd: string;
  nextRequestHandler?: RequestHandler;

  constructor(options: HttpNextProps);
  start(): Promise<() => void>;  // 返回关闭函数
}
```

---

## 3. 代码生成模板与规则

### 3.1 创建并启动服务（与 @hile/core 集成）

```typescript
import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService(async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, ".."),
    publicPath: "public",
  });
  shutdown(await httpNext.start());
  return httpNext;
});
```

### 3.2 控制器文件

控制器使用 `@hile/http` 的 `defineController`，放在 `src/app/` 下：

```typescript
// src/app/post.controller.ts  →  路由: GET /-/post
import { defineController } from "@hile/http";

export default defineController("GET", async (ctx) => {
  return { id: 1, title: "Hello" };
});
```

路径映射（prefix = `/-`）：

| 文件 | 路由 |
|------|------|
| `src/app/post.controller.ts` | `/-/post` |
| `src/app/users/index.controller.ts` | `/-/users` |
| `src/app/users/[id].controller.ts` | `/-/users/:id` |

### 3.3 强制规则

1. **控制器路由前缀必须为 `/-`**，禁止使用其他前缀
2. **Next.js 页面路由**放在 `src/app/` 下（`page.tsx`、`layout.tsx` 等），与控制器共存
3. **不要在控制器文件中导出 React 组件**，控制器文件只处理 API 逻辑
4. `start()` 只调用一次，它内部完成：静态资源注册 → HTTP 启动 → Next.js prepare → 控制器加载

### 3.4 反模式

```typescript
// ❌ 不要在 start() 之后再手动 use() 或 load()
await httpNext.start();
httpNext.http.get("/foo", handler); // 错误：http 是 private 的

// ❌ 不要给控制器路由使用非 /- 前缀
// 这会与 Next.js 页面路由冲突

// ❌ 不要在控制器中操作 ctx.res.end()
// Next.js handler 会接管响应
```

### 3.5 tsconfig 约定

项目需两份 tsconfig：

- `tsconfig.json`：用于编译控制器等 Node.js 代码，`exclude` 不应包含 `src/app`
- `tsconfig.next.json`：用于 Next.js 构建，`include` 为 `src/app/**/*`
