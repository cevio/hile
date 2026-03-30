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

- `src/services/index.boot.ts` — Hile 服务入口（`*.boot` 须在 `src/services/`）；本模板使用 **`controllerDirectory: "app"`**，故 API 控制器与页面同放在 **`src/app/*.controller.ts`**。默认推荐为 **`src/controllers/`**（见 **`packages/http-next/SKILL.md`**）。
- `src/app/page.tsx`、`layout.tsx` 等 — Next.js 页面与布局
- 业务数据：在 **`src/models/*.model.ts`** 中 **`defineModel`**；页面内可直接 **`loadModel(xxxModel, …)`**；控制器 **`import`** models 导出函数。**`loadService`** 不得在页面或控制器中直用。

详见 **`packages/http-next/SKILL.md`** 与 [Hile 文档](https://github.com/cevio/hile)。
