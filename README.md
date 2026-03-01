# Hile Monorepo

Hile 是一套面向 Node.js 的轻量级服务化工具集，采用 `pnpm workspaces + Lerna` 管理多包仓库。

## 包一览

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@hile/core`](./packages/core) | 异步服务容器：单例、并发合并、生命周期、依赖图、循环依赖检测 | 1.0.11 |
| [`@hile/http`](./packages/http) | HTTP 服务框架：Koa + find-my-way，支持中间件和文件路由 | 1.0.10 |
| [`@hile/cli`](./packages/cli) | 命令行启动器：支持 `auto_load_packages` 与 `*.boot` 自动加载，内置容器事件日志 | 1.0.4 |
| [`@hile/typeorm`](./packages/typeorm) | TypeORM DataSource 的 Hile 服务封装，内置事务辅助 | 1.0.2 |
| [`@hile/ioredis`](./packages/ioredis) | ioredis 客户端的 Hile 服务封装，支持优雅断连 | 1.0.1 |

## 仓库结构

```text
├── packages/
│   ├── core/              # @hile/core
│   ├── http/              # @hile/http
│   ├── cli/               # @hile/cli
│   ├── typeorm/           # @hile/typeorm
│   └── ioredis/           # @hile/ioredis
├── scripts/
│   └── create-package.sh  # 新包脚手架
├── package.json           # 根配置（workspaces + scripts）
├── pnpm-workspace.yaml
├── lerna.json             # independent 版本模式
└── tsconfig.json          # 基础 TypeScript 配置
```

## 环境要求

- Node.js：建议 `>= 20`
- pnpm：建议 `>= 8`

## 快速开始

```bash
pnpm install
pnpm run build
pnpm run test
```

## 核心特性（第二层落地）

- `@hile/core`
  - 生命周期：`init -> ready -> stopping -> stopped`
  - 启动/销毁超时控制（`startTimeoutMs`、`shutdownTimeoutMs`）
  - 可观测事件（`onEvent`）
  - 依赖图导出与循环依赖检测
- `@hile/cli`
  - 已接入容器事件日志，默认输出启动、失败、关闭阶段信息与耗时

## 常用命令

### 全局操作

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 编译所有包 |
| `pnpm run test` | 运行所有包测试 |
| `pnpm run dev` | 所有包进入监听模式 |

### 单包操作

将 `<pkg>` 替换为包名（如 `@hile/core`）：

| 命令 | 说明 |
|------|------|
| `pnpm --filter <pkg> build` | 编译指定包 |
| `pnpm --filter <pkg> test` | 测试指定包 |
| `pnpm --filter <pkg> dev` | 指定包监听开发 |

## 新增包

```bash
pnpm run create <包名>
```

例如：

```bash
pnpm run create utils
```

脚本会自动完成：

1. 创建 `packages/<name>/` 与 `src/index.ts`
2. 生成 `package.json`（含 build/dev/test 脚本）
3. 生成 `tsconfig.json`（继承根配置）
4. 执行 `pnpm install`

### 添加包间依赖

```bash
pnpm --filter @hile/utils add @hile/core --workspace
```

## 发布

Lerna 使用 `independent` 版本策略，各包独立发布。

| 命令 | 说明 |
|------|------|
| `npx lerna changed` | 查看有变更的包 |
| `pnpm run publish` | 交互式发布变更包 |
| `npx lerna publish patch` | 统一发布补丁版本 |
| `npx lerna publish minor` | 统一发布次版本 |
| `npx lerna publish major` | 统一发布主版本 |

## License

MIT
