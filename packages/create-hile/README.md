# create-hile

基于 `@hile/http-next` 的项目脚手架，一条命令创建开箱即用的 Hile + Next.js 项目。

## 使用方式

```bash
# 推荐：通过 npx 直接运行
npx create-hile create my-app

# 或全局安装后使用
npm i -g create-hile
create-hile create my-app
```

创建完成后：

```bash
cd my-app
pnpm install
pnpm run dev
```

## 生成的项目结构

```text
my-app/
├── public/                    # 静态资源
│   ├── next.svg
│   ├── vercel.svg
│   └── ...
├── src/
│   ├── app/
│   │   ├── layout.tsx         # Next.js 根布局
│   │   ├── page.tsx           # Next.js 首页
│   │   ├── page.module.css    # 页面样式
│   │   ├── globals.css        # 全局样式
│   │   └── click.tsx          # Client 组件示例
│   ├── controllers/
│   │   └── post.controller.ts # API 示例 → GET /-/post
│   ├── models/
│   │   ├── home/
│   │   │   └── home.model.ts  # 首页 defineModel（export default）
│   │   └── post/
│   │       └── post.model.ts  # /-/post defineModel（export default）
│   └── services/
│       └── index.boot.ts      # 服务启动入口（*.boot 须在 src/services/）
├── next.config.ts
├── tsconfig.json               # Node.js 编译
├── tsconfig.next.json          # Next.js 编译
├── eslint.config.mjs
└── package.json
```

业务数据与 **`loadModel`** / **`defineModel`** 以 **`packages/http-next/SKILL.md`** 为准：**`src/models/<领域>/*.model.ts`**（**`export default`**）；**`app` / `controllers` / `services`** 仅 **`loadModel`** 消费 model；**`page.tsx`** 使用 **`loadModel`** 须 **`export const dynamic = "force-dynamic"`**；**`controllers`** 可 **`loadService`**；**`app`** **禁止** **`loadService`**。

## 生成项目的可用命令

| 命令 | 说明 |
|------|------|
| `pnpm run dev` | 构建 Next.js 并以开发模式启动 Hile 服务 |
| `pnpm run build` | 编译 TypeScript 与 Next.js 生产构建 |
| `pnpm run start` | 以生产模式启动 Hile 服务 |

## 技术栈

生成的项目基于以下依赖：

- **@hile/core** — 异步服务容器
- **@hile/http** — Koa + find-my-way HTTP 框架
- **@hile/http-next** — Next.js 桥接层
- **@hile/cli** — 命令行启动器（`hile start`）
- **Next.js 16** — React 服务端渲染与 App Router
- **React 19** — UI 渲染

## License

MIT
