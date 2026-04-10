# Hile Monorepo

Hile 是一套面向 Node.js 的轻量级服务化工具集，采用 `pnpm workspaces + Lerna` 管理多包仓库。

## 5 分钟跑通

```bash
pnpm install
pnpm run build
pnpm run test
```

## 包一览

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@hile/core`](./packages/core) | 异步服务容器：单例、并发合并、生命周期、依赖图、循环依赖检测 | 1.1.2 |
| [`@hile/http`](./packages/http) | HTTP 服务框架：Koa + find-my-way，中间件、文件系统路由，可选 Zod 校验 | 1.1.0 |
| [`@hile/http-next`](./packages/http-next) | Next.js 桥接层：将 Next.js 作为渲染引擎嵌入 `@hile/http`，共享同一 HTTP 服务 | 1.1.6 |
| [`@hile/cli`](./packages/cli) | 命令行启动器：支持 `auto_load_packages` 与 `*.boot` 自动加载，内置容器事件日志 | 1.1.3 |
| [`@hile/typeorm`](./packages/typeorm) | TypeORM DataSource 的 Hile 服务封装，内置事务辅助 | 1.1.4 |
| [`@hile/ioredis`](./packages/ioredis) | ioredis 客户端的 Hile 服务封装，支持优雅断连 | 1.1.2 |
| [`@hile/message-modem`](./packages/message-modem) | 传输无关的请求/响应消息通信抽象层，支持超时、中止、错误传播 | 1.0.6 |
| [`@hile/message-ipc`](./packages/message-ipc) | Node.js IPC 通信实现，基于 message-modem，用于父子进程请求/响应 | 1.0.6 |
| [`@hile/message-worker-thread`](./packages/message-worker-thread) | Worker Threads 通信实现，基于 message-modem，用于主线程与 Worker 请求/响应 | 1.0.5 |
| [`@hile/message-ws`](./packages/message-ws) | WebSocket 通信实现，基于 message-modem + ws，用于客户端/服务端请求/响应 | 1.0.5 |
| [`@hile/message-loader`](./packages/message-loader) | 基于文件系统的消息路由加载器，将目录结构映射为路由表，适配各种 message 通信模块 | 1.0.7 |
| [`create-hile`](./packages/create-hile) | 项目脚手架：一键创建 Hile + Next.js 应用 | 1.1.6 |

### 快速创建项目

```bash
npx create-hile create my-app
cd my-app
pnpm install
pnpm run dev
```

### 依赖关系

```
@hile/core
  ├── @hile/cli        （启动器依赖核心容器）
  ├── @hile/typeorm     （服务封装依赖核心容器）
  └── @hile/ioredis     （服务封装依赖核心容器）

@hile/http
  └── @hile/http-next   （桥接层依赖 HTTP 框架）

@hile/message-modem     （独立模块，无外部依赖）
  ├── @hile/message-ipc            （IPC 实现，依赖 message-modem）
  ├── @hile/message-worker-thread  （Worker Threads 实现，依赖 message-modem）
  └── @hile/message-ws             （WebSocket 实现，依赖 message-modem + ws）

@hile/message-loader    （独立模块，文件系统消息路由加载器）
  └── 可搭配 message-ipc / message-worker-thread / message-ws 使用

create-hile   （脚手架，生成的项目依赖上述所有包）
```

## 仓库结构

```text
├── packages/
│   ├── core/           # 异步服务容器
│   ├── http/           # HTTP 服务框架
│   ├── http-next/      # Next.js 桥接层
│   ├── cli/            # 命令行启动器
│   ├── typeorm/        # TypeORM 服务封装
│   ├── ioredis/        # ioredis 服务封装
│   ├── message-modem/  # 消息通信抽象层
│   ├── message-ipc/    # IPC 通信实现
│   ├── message-worker-thread/  # Worker Threads 通信实现
│   ├── message-ws/             # WebSocket 通信实现
│   ├── message-loader/         # 文件系统消息路由加载器
│   └── create-hile/  # 项目脚手架
├── docs/               # Mintlify 文档
├── scripts/
├── package.json
├── pnpm-workspace.yaml
├── lerna.json
└── tsconfig.json
```

## 文档策略

| 文件 | 面向 | 职责 |
|------|------|------|
| 各包 `README.md` | 使用者 | 快速安装与跑通、核心用法、与仓库内其他包的配合 |
| 各包 `SKILL.md` | AI 编码模型 / 贡献者 | 强约束、类型与签名、代码模板、反模式与边界条件 |
| `docs/*.mdx` | 使用者（线上文档） | 完整使用指南、API 参考、常见问题与排错 |

## 常用命令

| 命令             | 说明               |
| ---------------- | ------------------ |
| `pnpm run build` | 编译所有包         |
| `pnpm run test`  | 运行所有包测试     |
| `pnpm run dev`   | 所有包进入监听模式 |

## License

MIT
