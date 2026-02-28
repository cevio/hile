# @hile/cli

Hile 命令行工具，用于启动基于 `@hile/core` 的服务应用。支持通过 `package.json` 配置和/或自动扫描 `*.boot.{ts,js}` 文件加载服务，并注册退出钩子实现优雅关闭。

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

在**当前工作目录**（通常为项目根，且含 `package.json`）下启动服务。按以下顺序加载服务并启动：

1. **package.json 中的 `hile.auto_load_packages`**（若存在）：按数组顺序加载所列**模块名**的默认导出作为服务。
2. **运行时目录下的 `*.boot.ts` / `*.boot.js`**：扫描并加载每个文件的默认导出作为服务。

若上述两者均未提供任何可加载项，CLI 会输出 `no services to load` 并退出。每个加载项（模块或 boot 文件）的默认导出须通过 `isService` 校验，否则会抛出 `invalid service file`。

```bash
hile start          # 生产模式：NODE_ENV=production，扫描 dist/ 目录
hile start --dev    # 开发模式：NODE_ENV=development，扫描 src/ 目录（通过 tsx 支持 TypeScript）
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-d, --dev` | 开发模式：设置 `NODE_ENV=development`，使用 tsx 运行 TypeScript，扫描 `src/` | `false` |

未使用 `--dev` 时，CLI 会将 `process.env.NODE_ENV` 设为 `production`；使用 `--dev` 时设为 `development`，便于业务代码区分环境。

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

## package.json 配置（可选）

在项目根目录的 `package.json` 中可增加 `hile.auto_load_packages`，用于在扫描 boot 文件**之前**先加载指定模块的默认导出作为服务：

```json
{
  "name": "my-app",
  "hile": {
    "auto_load_packages": ["@hile/http", "my-local-service"]
  }
}
```

- **含义**：数组中的每一项为**模块名**（与 `import('模块名')` 一致），不能写文件路径。
- **顺序**：按数组顺序依次加载，再加载运行时目录下的 `*.boot.{ts,js}`。
- **要求**：每个模块的默认导出必须是 `defineService` / `container.register` 的返回值（通过 `isService` 校验）。若无 `hile` 或 `auto_load_packages`，则仅通过 boot 文件加载服务。
- **注意**：`hile` 配置为可选项。若当前工作目录存在 `package.json`，会读取其中可选的 `hile.auto_load_packages` 并优先加载；未配置该项时，仅通过 boot 文件加载服务。

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
├── package.json             # 可含 hile.auto_load_packages
└── tsconfig.json
```

服务加载来源：先按 `package.json` 的 `hile.auto_load_packages`（若有）加载模块默认导出，再扫描运行时目录下的 `*.boot.{ts,js}`；其余服务通过 `loadService` 按需加载。

## 开发

```bash
pnpm install
pnpm build        # 编译
pnpm dev          # 监听模式
```

## License

MIT
