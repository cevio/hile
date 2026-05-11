# create-hile

基于内置模板的 Hile 项目脚手架：交互选择模板后，一条命令复制完整工程并写好 `package.json` 项目名。

## 内置模板

| 目录名 | 说明 |
|--------|------|
| `default` | 默认 Hile + HTTP |
| `next` | Next.js + `@hile/http-next` 全栈 |
| `micro-http` | `@hile/micro` + HTTP |
| `micro` | 独立 Micro 服务 |
| `micro-http-next` | Next.js + Micro + HTTP |

模板仓库内部分环境文件以 **`_env`、`_env.prod`、`_gitignore`** 命名；创建项目时会自动重命名为 **`.env`、`.env.prod`、`.gitignore`**。

## 使用方式

```bash
# 推荐：通过 npx 直接运行
npx create-hile create my-app

# 或全局安装后使用
npm i -g create-hile
create-hile create my-app
```

按提示选择模板与是否安装依赖。完成后：

```bash
cd my-app
pnpm install   # 若创建时未选安装依赖
pnpm run dev   # 具体脚本以该模板的 package.json 为准
```

## 生成的项目结构（`next` 模板示例）

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
| `pnpm run dev` | 构建 Next.js 并以开发模式启动 Hile 服务（以模板为准） |
| `pnpm run build` | 编译 TypeScript 与 Next.js 生产构建 |
| `pnpm run start` | 以生产模式启动 Hile 服务 |

## 技术栈（`next` 类模板）

生成的项目基于以下依赖（其他模板可能包含 `@hile/micro` 等而不含 Next）：

- **@hile/core** — 异步服务容器
- **@hile/http** — Koa + find-my-way HTTP 框架
- **@hile/http-next** — Next.js 桥接层
- **@hile/cli** — 命令行启动器（`hile start`）
- **Next.js 16** — React 服务端渲染与 App Router
- **React 19** — UI 渲染

## License

MIT
