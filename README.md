# Hile

Hile monorepo，使用 pnpm workspaces + Lerna 管理。

## 包一览

| 包名 | 说明 | 版本 |
|------|------|------|
| [`@hile/core`](./packages/core) | 轻量级异步服务容器，提供单例管理、并发合并和生命周期销毁 | 1.0.11 |
| [`@hile/http`](./packages/http) | HTTP 服务框架，基于 Koa + find-my-way，支持路由注册、中间件和文件路由加载 | 1.0.10 |
| [`@hile/cli`](./packages/cli) | 命令行启动器，支持 `auto_load_packages` 与 `*.boot` 文件加载、优雅退出 | 1.0.4 |
| [`@hile/typeorm`](./packages/typeorm) | TypeORM DataSource 封装为 Hile 服务，含 `transaction` 事务辅助 | 1.0.2 |
| [`@hile/ioredis`](./packages/ioredis) | ioredis 客户端封装为 Hile 服务，环境变量配置、退出时断开连接 | 1.0.1 |

## 项目结构

```
├── packages/
│   ├── core/              # @hile/core
│   ├── http/              # @hile/http
│   ├── cli/               # @hile/cli
│   ├── typeorm/           # @hile/typeorm
│   └── ioredis/           # @hile/ioredis
├── scripts/
│   └── create-package.sh  # 新包脚手架脚本
├── package.json           # 根配置（workspaces + scripts）
├── pnpm-workspace.yaml
├── lerna.json             # independent 版本模式
└── tsconfig.json          # 基础 TypeScript 配置（各包继承）
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 编译所有包
pnpm run build

# 运行所有测试
pnpm run test
```

## 开发命令

### 全局操作

| 命令 | 说明 |
|------|------|
| `pnpm run build` | 编译所有包 |
| `pnpm run test` | 运行所有包的测试 |
| `pnpm run dev` | 所有包进入监听模式 |

### 单包操作

将 `<pkg>` 替换为包名，如 `@hile/core`、`@hile/http`：

| 命令 | 说明 |
|------|------|
| `pnpm --filter <pkg> build` | 编译指定包 |
| `pnpm --filter <pkg> test` | 运行指定包的测试 |
| `pnpm --filter <pkg> dev` | 指定包进入监听模式 |

## 添加新包

使用脚手架脚本一键创建：

```bash
pnpm run create <包名>
```

例如：

```bash
pnpm run create utils
```

脚本会自动完成：
1. 创建 `packages/utils/` 目录和 `src/index.ts` 入口
2. 生成 `package.json`（包名 `@hile/utils`，含 build/dev/test 脚本）
3. 生成 `tsconfig.json`（继承根配置）
4. 运行 `pnpm install` 安装依赖

### 包间依赖

```bash
pnpm --filter @hile/utils add @hile/core --workspace
```

## 发布

Lerna 使用 `independent` 版本模式，各包独立管理版本号。

| 命令 | 说明 |
|------|------|
| `npx lerna changed` | 预览有变更的包 |
| `pnpm run publish` | 发布所有有变更的包（交互式选择版本） |
| `npx lerna publish patch` | 所有变更包发布补丁版本 |
| `npx lerna publish minor` | 所有变更包发布次版本 |
| `npx lerna publish major` | 所有变更包发布主版本 |

## License

MIT
