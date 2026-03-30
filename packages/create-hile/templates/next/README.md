# Hile + Next.js

基于 [Hile](https://github.com/cevio/hile) 与 Next.js 的全栈项目。API 路由（`/-` 前缀）与页面路由共享同一端口。

## 快速开始

```bash
pnpm install
pnpm run dev
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。示例 API：`curl http://localhost:3000/-/post`。

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 构建 Next.js 并以开发模式启动 Hile 服务 |
| `pnpm run build` | 编译 TypeScript 与 Next.js 生产构建 |
| `pnpm run start` | 生产模式启动（需先执行 `pnpm run build`） |

## 项目结构

```
src/
├── app/                 # Next.js App Router（禁止 loadService / defineModel）
├── controllers/         # *.controller.ts → 默认 GET /-/…（可 loadService / loadModel）
├── models/              # <领域>/*.model.ts：单文件 export default defineModel
└── services/            # *.boot.ts | *.service.ts（*.boot 由 CLI 自启动）
```

- **`src/services/index.boot.ts`**：`HttpNext` 与 **`cwd`**（见 **`packages/http-next/SKILL.md`**）。
- **`src/models/<领域>/*.model.ts`**：领域数据；**`src/app/page.tsx`** 示范 **`loadModel`** + **default** **import**。
- **`src/controllers/post.controller.ts`**：示范 **`loadModel(postModel, …)`**。

**`loadService`** 仅可在 **`src/services`**、**`src/models`**、**`src/controllers`** 中使用，**禁止**在 **`src/app`**。

详见 **`packages/http-next/SKILL.md`** 与 [Hile 文档](https://pulian.mintlify.app/packages/http-next)。
