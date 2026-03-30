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

Boot 文件须为 **`src/services/*.boot.ts`**（见根 **`SKILL.md`** / **`@hile/cli`**）。

```typescript
// src/services/index.boot.ts
import HttpNext from "@hile/http-next";
import { defineService } from "@hile/core";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineService('http.next', async (shutdown) => {
  const httpNext = new HttpNext({
    port: 3000,
    cwd: resolve(__dirname, "../.."),
    publicPath: "public",
  });
  shutdown(await httpNext.start());
  return httpNext;
});
```

## 工作原理

`HttpNext` 在一个 HTTP 服务上同时运行 Koa 路由和 Next.js：

```
Request → Koa 中间件 → koa-static → hile-http 路由(默认 /-*) → Next.js handler
```

- **Next.js App Router**：页面仍在 `src/app/`（`page.tsx`、`layout.tsx` 等）
- **hile-http API（非 Next 路由）**：**全部**放在 **`src/controllers/`**（开发）或 **`dist/controllers/`**（生产）下的 `*.controller.ts`；默认从该目录加载，路由前缀默认为 **`/-`**（可用 `controllerPrefix` 修改）；`http.load` 使用 **`conflict: "error"`**
- **数据分层**：**`loadService`** / 直引 **`src/services/**`**：**禁止**在 **`src/app/**`**、**`src/controllers/**`**。**`defineModel`** 仅 **`src/models`**。**`src/app/**`** 可 **`loadModel(xxxModel, …)`**（**`xxxModel`** 从 models 导入）；**`src/controllers/**`** **`import`** models 导出函数，**禁止** **`loadModel`**（详见 **`SKILL.md`**）。
- **系统 vs 业务**：**系统/基础设施逻辑**（连接、资源、与 Hile 集成）**全部**写在 **`src/services/*.service.*`**（及 **`*.boot.*`**）；**业务/领域逻辑** **全部**写在 **`src/models/*.model.*`**（见 **`SKILL.md`** §2.3–§2.4）。
- **`src/services/`**：**`*.boot.*`** 与 **`*.service.*`** **同属** service 模块；**`.boot`** = CLI **自启动**，**`.service`** = **`loadService`** **依赖加载**（见根 **`SKILL.md`**）。

## API 路由（控制器）

在默认的 **`src/controllers/`** 下创建 `*.controller.ts`（若需与旧版一致放在 `src/app/`，请设置 **`controllerDirectory: "app"`**）：

```typescript
// src/controllers/post.controller.ts → GET /-/post
import { defineController } from "@hile/http";

export default defineController("GET", async (ctx) => {
  return { id: 1, title: "Hello" };
});
```

### 路径映射（默认）

| 文件路径 | HTTP 路由 |
|---------|----------|
| `src/controllers/post.controller.ts` | `/-/post` |
| `src/controllers/users/index.controller.ts` | `/-/users` |
| `src/controllers/users/[id].controller.ts` | `/-/users/:id` |

## API

### `HttpNextProps`

| 属性 | 类型 | 默认值 | 说明 |
|------|------|-------|------|
| `port` | `number` | — | 监听端口（必填） |
| `cwd` | `string` | `process.cwd()` | 项目根目录 |
| `publicPath` | `string` | — | 静态资源目录（相对于 cwd） |
| `controllerDirectory` | `string` | `"controllers"` | 控制器目录名（相对于 `src/` 或 `dist/`） |
| `controllerPrefix` | `string` | `"/-"` | `http.load` 的 `prefix` |
| `controllerSuffix` | `string` | `"controller"` | `http.load` 的 `suffix`（文件名 `*.controller.ts`） |
| `keys` | `string[]` | — | Koa 签名密钥 |

### `HttpNext`

| 属性 / 方法 | 说明 |
|------------|------|
| `use(middleware)` | 注册 Koa 中间件，返回当前实例以支持链式调用 |
| `start()` | 启动服务，返回 `Promise<() => void>` 关闭函数 |

### `start()` 执行流程

1. 注册 `publicPath` 与 `.next/static` 静态资源（构造函数与 start 内）
2. 加载控制器：`http.load(resolve(cwd, src|dist, controllerDirectory), { suffix, defaultSuffix, prefix, conflict: "error" })`
3. 启动 HTTP 服务（`http.listen()`）
4. 在 `onListen` 回调中：创建 Next 应用并 `prepare()`，挂载 Next.js 转发中间件

## 项目结构（推荐）

```
my-app/
├── public/
├── src/
│   ├── app/                  # Next.js 页面
│   │   ├── layout.tsx
│   │   └── page.tsx
│   ├── controllers/          # API 控制器（默认）
│   │   └── post.controller.ts
│   └── services/
│       └── index.boot.ts       # *.boot 须在 src/services/
├── next.config.mjs
├── tsconfig.json
└── tsconfig.next.json
```

## License

MIT
