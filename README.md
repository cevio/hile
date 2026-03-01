# Hile Monorepo

Hile 是一套面向 Node.js 的轻量级服务化工具集，采用 `pnpm workspaces + Lerna` 管理多包仓库。

## 5 分钟跑通

```bash
pnpm install
pnpm run build
pnpm run test
```

如果你要快速体验一个应用启动流程：

```bash
# 进入你的应用目录（示例）
# hile start --dev
```

## 包一览

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@hile/core`](./packages/core) | 异步服务容器：单例、并发合并、生命周期、依赖图、循环依赖检测 | 1.0.11 |
| [`@hile/http`](./packages/http) | HTTP 服务框架：Koa + find-my-way，支持中间件和文件路由 | 1.0.10 |
| [`@hile/cli`](./packages/cli) | 命令行启动器：支持 `auto_load_packages` 与 `*.boot` 自动加载，内置容器事件日志 | 1.0.4 |
| [`@hile/typeorm`](./packages/typeorm) | TypeORM DataSource 的 Hile 服务封装，内置事务辅助 | 1.0.2 |
| [`@hile/ioredis`](./packages/ioredis) | ioredis 客户端的 Hile 服务封装，支持优雅断连 | 1.0.1 |

## 文档策略

为了降低学习成本并提高协作一致性，仓库采用如下策略：

- `README.md`：面向使用者，强调“快速跑通”和最少必要说明
- `SKILL.md`：面向代码生成器/规范执行，强调强约束、反模式、边界条件
- `docs/adr/*`：记录关键架构决策（ADR）及其取舍理由

## 仓库结构

```text
├── packages/
│   ├── core/
│   ├── http/
│   ├── cli/
│   ├── typeorm/
│   └── ioredis/
├── docs/
│   └── adr/              # Architecture Decision Records
├── scripts/
├── package.json
├── pnpm-workspace.yaml
├── lerna.json
└── tsconfig.json
```

## 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 编译所有包 |
| `pnpm run test` | 运行所有包测试 |
| `pnpm run dev` | 所有包进入监听模式 |

## License

MIT
