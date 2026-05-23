---
name: http-next
description: "@hile/http-next: Koa + 文件路由与 Next 同端口。model 定义见 @hile/model。业务放 src/models, page.tsx+loadModel 须 dynamic=force-dynamic。"
---

# @hile/http-next

与仓库根 **`SKILL.md`** 一并遵守。Koa + 文件路由与 Next 同端口：**静态** → **API（默认 `/-`）** → **Next**。

## 分层（硬约束）

| 位置 | 做什么 | 禁止 |
|------|--------|------|
| **`src/models/<领域>/*.model.ts`** | **全部业务逻辑**；**一个文件一个** **`defineModel`**；**`export default`**；内可 **`loadService`** / **`loadModel`** 其他 default | 多 **`defineModel`**；根目录堆文件；**命名导出**给外层当取数入口 |
| **`src/app/**`** | UI、**`import m from "…/….model"`** + **`loadModel(m, …)`**；**凡 `page.tsx` 内调用 `loadModel`，同文件须** **`export const dynamic = "force-dynamic"`** | **`loadService`**、**`defineModel`**、**业务逻辑**、直引 **`src/services`**；**`page.tsx` 已用 `loadModel` 却未导出 `dynamic`** |
| **`src/controllers/**`** | 薄 HTTP：**`loadModel`** / **`loadService`** | **业务逻辑**、**`import { … }`** 从 **`*.model.ts`** 直接取数 |
| **`src/services/**`** | **`*.boot.*`** / **`*.service.*`**；要业务数据则 **`loadModel`** | **业务规则**；绕过 **`loadModel`** 用 model |

**Boot**：**`*.boot.*`** 只在 **`src/services/`**；**`cwd: resolve(__dirname, "../..")`**（相对该文件）。**`HttpNext`** 未传 **`cwd`** 则用 **`process.cwd()`**。

**控制器目录**：默认 **`src/controllers`**；API 写在 **`src/app`** 下则 **`controllerDirectory: "app"`**。生产：**`resolve(cwd, dist|src, controllers)`**，**tsc** 产出 **`dist/models`** 等与 **`src`** 同结构。

**`http.load`**：**`conflict: "error"`**。

**控制器校验**：与纯 **`@hile/http`** 相同，可使用 **`createControllerMetadata`** + **Zod** 与 **`defineController(metadata, fn)`** 校验 **`query` / `params` / `request.body`**，失败 **`400`**（见 **`packages/http/SKILL.md`**）。

**额外 API 根（可选）**：**`specialControllers?: { directory: string; prefix: string }[]`**。在默认 **`load`** 之后，对每一项依次 **`resolve(cwd, src|dist, directory)`** 再 **`http.load`**，**`suffix` / `defaultSuffix` / `conflict`** 与主控制器相同，**`prefix`** 取该项的 **`prefix`**。用于同一项目里多套 API 前缀（如主 **`/-`** +  **`/admin`**）。

## Model（`@hile/model`）

model 定义与消费由独立包 **`@hile/model`** 提供：

- **`defineModel`** / **`loadModel`** / **`isModel`** / **`ModelDefinition`** 自 **`@hile/model`** 导入。
- 非容器单例；**每次** **`loadModel`** 都重新执行 `defineModel` 中的 `main`。
- **`app` / `controllers` / `services`** 消费 model：**只认** **`loadModel(defaultImport, …)`**；首参非法 → **`TypeError`**。
- 基础设施 → **`defineService` + `loadService`**；领域结果 → **`defineModel` + `loadModel`**。

**Next.js `page.tsx`（强制）**：在 App Router 的**任意** **`page.tsx`** 中**一旦**使用 **`loadModel`**，**必须**在**同一文件**顶层增加 **`export const dynamic = "force-dynamic";`**。否则与动态数据/运行时取数不匹配，且不符合本包约定。**`layout.tsx`** 等若未调用 **`loadModel`** 则不要求；**仅在调用 `loadModel` 的 `page.tsx` 中**必须导出。

```typescript
// src/models/foo/foo.model.ts
import { defineModel } from "@hile/model";
export default defineModel(async (slug: string) => ({ slug }));

// src/app/foo/page.tsx
import { loadModel } from "@hile/model";
import fooModel from "@/models/foo/foo.model";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <div>{(await loadModel(fooModel, "x")).slug}</div>;
}
```

## `HttpNext`（摘要）

```typescript
import type { SpecialController } from "@hile/http-next";

const extra: SpecialController[] = [
  { directory: "admin-api", prefix: "/admin" }, // src/admin-api/*.controller.ts → /admin/…
];

new HttpNext({
  port: 3000,
  cwd: resolve(__dirname, "../.."), // 项目根
  publicPath: "public", // 或 string[]，如 ["public", "static"] — 多个静态根各挂一层 koa-static
  controllerDirectory: "controllers", // 或 "app"
  controllerPrefix: "/-",             // 主 API 前缀
  specialControllers: extra, // 可选；多组 directory + prefix
});
// start(): … → load(主目录) → load(special 每项) → listen → Next prepare → 转发
```

**Boot（`src/services/*.boot.ts`）**

```typescript
import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
export default defineService("http.next", async (shutdown) => {
  const httpNext = new HttpNext({ port: 3000, cwd: resolve(__dirname, "../.."), publicPath: "public" });
  shutdown(await httpNext.start());
  return httpNext;
});
```

**路由（默认 prefix `/-`）**：`post.controller.ts` → `/-/post`；`users/index.controller.ts` → `/-/users`；`users/[id].controller.ts` → `/-/users/:id`。

## 反模式（摘）

**`page.tsx`** 使用 **`loadModel`** 却**未** **`export const dynamic = "force-dynamic"`**；在 **`app`/`controllers`/`services`** 写业务逻辑；**`*.model.ts`** 用 **`export const`** 替代 **default**；请求内 **`defineModel`**；**`app`** 用 **`loadService`**；控制器 **`ctx.res.end()`** 与 Next 抢响应；**`start()`** 后再改路由。

## 测试

**`src/index.test.ts`**：**`load`** 路径、**`specialControllers`** 追加 **`load`**、**`conflict`**。
