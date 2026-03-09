# Hile Monorepo

Hile 是一套面向 Node.js 的轻量级服务化工具集，采用 `pnpm workspaces + Lerna` 管理多包仓库。

## 5 分钟跑通

```bash
pnpm install
pnpm run build
pnpm run test
```

## 包一览

| 包名                                      | 说明                                                                           | 版本   |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------ |
| [`@hile/core`](./packages/core)           | 异步服务容器：单例、并发合并、生命周期、依赖图、循环依赖检测                   | 1.0.20 |
| [`@hile/http`](./packages/http)           | HTTP 服务框架：Koa + find-my-way，支持中间件和文件系统路由                     | 1.0.24 |
| [`@hile/http-next`](./packages/http-next) | Next.js 桥接层：将 Next.js 作为渲染引擎嵌入 `@hile/http`，共享同一 HTTP 服务   | 1.0.1  |
| [`@hile/cli`](./packages/cli)             | 命令行启动器：支持 `auto_load_packages` 与 `*.boot` 自动加载，内置容器事件日志 | 1.0.18 |
| [`@hile/typeorm`](./packages/typeorm)     | TypeORM DataSource 的 Hile 服务封装，内置事务辅助                              | 1.0.12 |
| [`@hile/ioredis`](./packages/ioredis)     | ioredis 客户端的 Hile 服务封装，支持优雅断连                                   | 1.0.12 |

### 依赖关系

```
@hile/core
  ├── @hile/cli        （启动器依赖核心容器）
  ├── @hile/typeorm     （服务封装依赖核心容器）
  └── @hile/ioredis     （服务封装依赖核心容器）

@hile/http
  └── @hile/http-next   （桥接层依赖 HTTP 框架）
```

## 仓库结构

```text
├── packages/
│   ├── core/           # 异步服务容器
│   ├── http/           # HTTP 服务框架
│   ├── http-next/      # Next.js 桥接层
│   ├── cli/            # 命令行启动器
│   ├── typeorm/        # TypeORM 服务封装
│   └── ioredis/        # ioredis 服务封装
├── docs/
│   └── adr/            # Architecture Decision Records
├── scripts/
├── package.json
├── pnpm-workspace.yaml
├── lerna.json
└── tsconfig.json
```

## 文档策略

| 文件         | 面向                   | 侧重                               |
| ------------ | ---------------------- | ---------------------------------- |
| `README.md`  | 使用者                 | 快速跑通、最少必要说明             |
| `SKILL.md`   | AI 编码模型 / 规范执行 | 强约束、类型签名、代码模板、反模式 |
| `docs/adr/*` | 架构讨论               | 关键决策及取舍理由                 |

## 常用命令

| 命令             | 说明               |
| ---------------- | ------------------ |
| `pnpm run build` | 编译所有包         |
| `pnpm run test`  | 运行所有包测试     |
| `pnpm run dev`   | 所有包进入监听模式 |

## License

MIT
