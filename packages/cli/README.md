# @hile/cli

Hile 命令行工具，用于启动基于 `@hile/core` 的服务应用。自动扫描并加载 `*.boot.{ts,js}` 文件，注册退出钩子实现优雅关闭。

## 安装

```bash
pnpm add @hile/cli
```

全局安装后可直接使用 `hile` 命令：

```bash
pnpm add -g @hile/cli
```

## 命令

### `hile start`

启动服务。扫描运行时目录下所有 `*.boot.ts` / `*.boot.js` 文件，加载其默认导出的服务并启动。

```bash
hile start          # 生产模式，扫描 dist/ 目录
hile start --dev    # 开发模式，扫描 src/ 目录（通过 tsx 支持 TypeScript）
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-d, --dev` | 开发模式，使用 tsx 运行 TypeScript | `false` |

### 其他

```bash
hile -v    # 查看版本号
hile -h    # 查看帮助
```

## 运行时目录

CLI 按以下优先级确定扫描目录：

1. 环境变量 `HILE_RUNTIME_DIR`（如果设置）
2. 开发模式（`--dev`）→ `src/`
3. 生产模式 → `dist/`

可通过环境变量自定义：

```bash
HILE_RUNTIME_DIR=./custom hile start
```

## Boot 文件规范

每个 `*.boot.ts` 文件必须默认导出一个通过 `defineService` 定义的服务：

```typescript
// src/database.boot.ts
import { defineService, loadService } from '@hile/core'
import { configService } from './services/config'

export default defineService(async (shutdown) => {
  const config = await loadService(configService)
  const pool = await createPool(config.dbUrl)
  shutdown(() => pool.end())
  return pool
})
```

**要求：**
- 文件名必须以 `.boot.ts` 或 `.boot.js` 结尾
- 必须有 `default` 导出
- 导出值必须是 `defineService` / `container.register` 的返回值（通过 `isService` 校验）

## 优雅关闭

进程收到退出信号时（SIGTERM、SIGINT 等），CLI 自动调用 `container.shutdown()` 按逆序销毁所有已启动的服务，确保资源正确释放。

## 项目结构示例

```
my-app/
├── src/
│   ├── database.boot.ts    # 数据库服务（自启动）
│   ├── http.boot.ts        # HTTP 服务（自启动）
│   └── services/
│       ├── config.ts        # 配置服务（被依赖，不自启动）
│       └── cache.ts         # 缓存服务（被依赖，不自启动）
├── package.json
└── tsconfig.json
```

只有 `*.boot.ts` 文件会被 CLI 自动加载和启动，其余服务通过 `loadService` 按需加载。

## 开发

```bash
pnpm install
pnpm build        # 编译
pnpm dev          # 监听模式
```

## License

MIT
