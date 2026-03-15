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

- `src/index.boot.ts` — Hile 服务入口
- `src/app/*.controller.ts` — API 控制器，自动挂载到 `/-` 前缀
- `src/app/page.tsx`、`layout.tsx` 等 — Next.js 页面与布局

详见 [Hile 文档](https://github.com/cevio/hile)。
