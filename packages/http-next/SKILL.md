---
name: http-next
description: "@hile/http-next 强约束：目录分层、cwd、HttpNext 选项；models 内 defineModel，src/app 可直接 loadModel。依赖本包须全文遵守。"
---

# @hile/http-next

面向 AI 与开发者的**代码生成规范**。依赖本包时须与根目录 **`SKILL.md`** 一并遵守；**禁止**节选条款或绕过 **models** 直引 **services**。

---

## 1. 职责与硬约束

`@hile/http`（Koa + 文件路由）与 Next.js 同进程、同端口：**静态资源** → **hile-http API（默认 `/-`）** → **Next handler**。

```
Request → Koa → koa-static(public / .next/static) → hile-http(默认 /-*) → Next
```

| 约束 | 要求 |
|------|------|
| API 根目录 | 默认 **`controllerDirectory: "controllers"`** → `src/controllers/`（生产 `dist/controllers/`）；与页面分目录需 **`controllerDirectory: "app"`** |
| API 前缀 | 默认 **`/-`**（`controllerPrefix`）；勿与页面路由冲突 |
| `http.load` | **`conflict: "error"`** |
| 业务数据 | **`loadService`** / 直引 **`src/services/**`**：**禁止**出现在 **`src/app/**`**、**`src/controllers/**`**（经 **`src/models`** 或 boot） |
| 首屏 / 页面数据 | **`defineModel`** **仅**在 **`src/models/*.model.*`**；**`src/app/**`** **允许** **`loadModel(xxxModel, …)`**（**`xxxModel`** 自 models **`import`**）；**禁止**在 **`src/app/**`** **`loadService` / `defineModel`**；**禁止**无附加逻辑时再包一层仅转调 **`loadModel`** 的函数；**`src/controllers/**`** **禁止** **`loadModel`**（须 **`import`** models 导出函数）；见 **§3** |
| Boot | 仅 **`src/services/**/*.boot.*`**；项目根 **`cwd`** 在 boot 内用 **`resolve(__dirname, "../..")`**（勿指到 `src/` 导致 `src/src/controllers`） |
| tsconfig | **`tsconfig.json`** 含 controllers/models/services；**`tsconfig.next.json`** 含 app + models |

---

## 2. 目录与构建

### 2.1 `cwd` 与 Boot

- **`cwd`**：Next 项目根（含 `next.config.*`、`package.json`、`src/`）。
- **`*.boot.*`**：仅 **`src/services/`**；**`cwd: resolve(__dirname, "../..")`**（相对 `src/services/` 下文件）。

### 2.2 推荐布局

```
<project-root>/
├── src/
│   ├── app/                 # Next：page、layout…
│   ├── controllers/         # 默认 API 根：*.controller.ts
│   ├── models/              # 业务：*.model.ts
│   └── services/            # *.boot.* | *.service.*
├── tsconfig.json            # Node：controllers / models / services
├── tsconfig.next.json       # Next：app + models
└── next.config.*
```

- **`*.controller.ts`**：仅在 **`controllers/`**（默认）或 **`controllerDirectory: "app"`** 时的 **`app/`**；**不要**放在 `models/`、`services/`。
- **`*.model.ts`**：仅在 **`src/models/`**；与 **`*.service.*`** 不同职责，文件名**不必**一一对应。

### 2.3 `src/services`（系统层）

- **`defineService`**：**`*.boot.*`** = CLI 自启动；**`*.service.*`** = **`loadService`** 依赖加载；**必须**均在 **`src/services/`**。
- **禁止**：业务规则写在此处；**`app/`**、**`controllers/`** **禁止**为取数 `import` 本目录。
- **`*.boot.*`** 不作为业务模块的常规 import 入口。

### 2.4 `src/models`（业务层）

- 领域规则、用例、编排**全部**在此；**`boot`** 与 **models** 内可 **`loadService`**。
- **controllers**：**`import`** models 已导出函数并 **`return`** 其结果；**不要**在控制器内 **`loadModel`**（见 **§3**）。
- **首屏业务数据**：**`defineModel`** 写在 **`src/models`**；**`src/app/**`** 内 **`await loadModel(xxxModel, …)`** 即可（**不要**无意义再包一层）。

### 2.5 `controllerDirectory`

- **默认 `"controllers"`**；与页面同放 **`src/app/**/*.controller.ts`** 时需 **`controllerDirectory: "app"`**，否则不会加载。

### 2.6 生产路径

`resolve(cwd, src|dist, controllerDirectory || "controllers")`。Node **tsc** 须产出 **`dist/controllers`**、**`dist/models`**、**`dist/services`** 等与 **`src/`** 同结构。

---

## 3. `defineModel` / `loadModel`

自 **`@hile/http-next`** 导出。**非** Hile 容器 key；**每次** **`loadModel`** 都会执行 **`create`**（无单例缓存）。

- **`defineModel(create)`**：**`create(...args) => T | Promise<T>`**；内部可 **`loadService`**。
- **`loadModel(model, ...args)`**：**`Promise.resolve().then(() => model.create(...args))`**（同步抛错 → reject）。

**分工**：基础设施 → **`defineService` + `loadService`**；领域结果 → **`defineModel` + `loadModel`**。

**必须遵守**

1. **`export const xxxModel = defineModel(...)`** 为模块顶层常量；**禁止**每次请求 **`defineModel(() => …)`**。
2. **`src/app/**`**：**可** **`import { loadModel } from "@hile/http-next"`** 与 **`import { fooModel } from "@/models/foo.model"`**，在 **`page` / `layout` 等** 内 **`await loadModel(fooModel, …)`**；**禁止** **`loadService`**、**`defineModel`**；**禁止**无附加逻辑时再导出/再写一层仅 **`return loadModel(…)`** 的包装函数。
3. **`src/controllers/**`**：**禁止** **`loadService`**；**禁止** **`loadModel`** — 只 **`import`** **`src/models`** 已导出 **`async function`**（其内部可 **`loadModel`**），并 **`return`**。
4. **models** 内业务数据**必须**经 **`defineModel` + `loadModel`** 链路产出；**禁止**对外的首屏/API 用例**仅** `await loadService(...)` 而无 **`loadModel`**。
5. 按请求区分数据 → 参数传入 **`loadModel(model, …)`**。

**示例**

```typescript
// src/models/foo.model.ts — 仅 defineModel（与 loadService 等）；不在此为 app 再包一层
import { defineModel } from "@hile/http-next";

export const fooModel = defineModel(async (slug: string) => {
  /* await loadService(…) … */
  return { slug };
});
```

```typescript
// src/app/foo/page.tsx — 直接 loadModel
import { loadModel } from "@hile/http-next";
import { fooModel } from "@/models/foo.model";

export default async function Page() {
  const data = await loadModel(fooModel, "x");
  return <div />;
}
```

**类型摘要**

```typescript
export type ModelDefinition<TArgs extends readonly unknown[] = readonly unknown[], T = unknown> = {
  readonly _hileModel: true;
  create(...args: TArgs): T | Promise<T>;
};
export function defineModel<TArgs extends readonly unknown[], T>(
  create: (...args: TArgs) => T | Promise<T>,
): ModelDefinition<TArgs, T>;
export function loadModel<TArgs extends readonly unknown[], T>(
  model: ModelDefinition<TArgs, T>,
  ...args: TArgs,
): Promise<T>;
```

---

## 4. 模板与清单

### 4.1 Boot（`src/services/index.boot.ts`）

```typescript
import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineService("http.next", async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, "../.."),
    publicPath: "public",
  });
  shutdown(await httpNext.start());
  return httpNext;
});
```

### 4.2 `HttpNext` 类型（摘要）

```typescript
import type { HttpProps } from "@hile/http";

export type HttpNextProps = HttpProps & {
  cwd?: string;
  publicPath?: string;
  controllerDirectory?: string; // 默认 "controllers"
  controllerPrefix?: string;   // 默认 "/-"
  controllerSuffix?: string;   // 默认 "controller"
};

export class HttpNext {
  constructor(options: HttpNextProps);
  start(onListen?: (server: import("http").Server) => void | Promise<void>): Promise<() => void>;
}
```

### 4.3 控制器（`src/controllers/post.controller.ts` → `GET /-/post`）

```typescript
import { defineController } from "@hile/http";
import { getPost } from "../models/post.model";

export default defineController("GET", async (ctx) => getPost(ctx));
```

| 文件 | 路由（prefix `/-`） |
|------|---------------------|
| `post.controller.ts` | `/-/post` |
| `users/index.controller.ts` | `/-/users` |
| `users/[id].controller.ts` | `/-/users/:id` |

### 4.4 检查清单

- `start()` 只调用一次；顺序：静态 → **`http.load`** → **`listen`** → Next **`prepare`** → 转发。
- 控制器**不**导出 React 组件；**只** `return`，由响应插件写 body。
- **`src/services`**：**`*.boot.*`** / **`*.service.*`** 命名与位置符合 **§2.3**。

### 4.5 反模式

- `start()` 后再改 **`Http`** 路由（**`http` 为 private**）。
- 控制器 **`ctx.res.end()`** 与 Next 抢响应。
- **`app/`** / **`controllers/`** **`loadService`** 或 **`import services`**；**`app/`** 内 **`defineModel`**。
- **`controllers/`** 内 **`loadModel`**（应 **`import`** models 导出函数）。
- **`app/`** 内无必要地再包一层 **`async function`**，**仅**为 **`return loadModel(…)`**。
- 首屏数据在 **models** 里**只** `loadService`、无 **`defineModel`/`loadModel`**。
- 每次请求 **`defineModel(…)`** 再 **`loadModel`**。

### 4.6 测试

- **`src/index.test.ts`**：`HttpNext.start()` → **`load`** 路径与 **`conflict: "error"`**。
- **`src/model.test.ts`**：**`defineModel`/`loadModel`** 传参与错误路径。
