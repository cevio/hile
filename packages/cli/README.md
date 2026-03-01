# @hile/cli

Hile 命令行工具，用于启动基于 `@hile/core` 的服务应用。支持通过 `package.json` 配置和/或自动扫描 `*.boot.{ts,js}` 加载服务，并在进程退出时执行优雅关闭。

## 安装

```bash
pnpm add @hile/cli
```

全局使用：

```bash
pnpm add -g @hile/cli
```

## 命令

### `hile start`

在当前工作目录（通常为项目根，且包含 `package.json`）启动服务。加载顺序如下：

1. `package.json` 中的 `hile.auto_load_packages`（如存在）
2. 运行时目录下的 `*.boot.ts` / `*.boot.js`

若两者都未提供可加载服务，CLI 输出 `no services to load` 并退出。每个加载项的默认导出都必须通过 `isService` 校验，否则抛出 `invalid service file`。

```bash
hile start
hile start --dev
```

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `-d, --dev` | 开发模式：`NODE_ENV=development`，使用 tsx，扫描 `src/` | `false` |
| `-e, --env-file <path>` | 加载 env 文件到 `process.env`，可多次指定 | — |

- 非 `--dev` 模式：`NODE_ENV=production`
- `--dev` 模式：`NODE_ENV=development`

示例：

```bash
hile start --env-file .env --env-file .env.local
```

依赖 Node 20.12+ 原生 `process.loadEnvFile()`。

### 其他命令

```bash
hile -v
hile -h
```

## 运行时目录

扫描目录优先级：

1. `HILE_RUNTIME_DIR`（若设置）
2. `--dev` 模式：`src/`
3. 生产模式：`dist/`

```bash
HILE_RUNTIME_DIR=./custom hile start
```

## package.json 配置（可选）

可在项目根目录配置 `hile.auto_load_packages`，用于在扫描 boot 文件之前先加载指定模块：

```json
{
  "name": "my-app",
  "hile": {
    "auto_load_packages": ["@hile/http", "my-local-service"]
  }
}
```

规则：

- 数组项必须是模块名（与 `import('module')` 语义一致）
- 按数组顺序加载，然后再扫描 `*.boot.{ts,js}`
- 每个模块默认导出必须是合法 Hile 服务（通过 `isService`）

## Boot 文件规范

每个 `*.boot.ts` / `*.boot.js` 文件必须默认导出一个服务：

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

要求：

- 文件名后缀必须为 `.boot.ts` 或 `.boot.js`
- 必须存在 `default` 导出
- 导出值必须为 `defineService` / `container.register` 返回值

## 优雅关闭

进程收到 `SIGTERM`、`SIGINT` 等信号时，CLI 会自动调用 `container.shutdown()`，按逆序销毁已启动服务。

## 项目结构示例

```text
my-app/
├── src/
│   ├── database.boot.ts
│   ├── http.boot.ts
│   └── services/
│       ├── config.ts
│       └── cache.ts
├── package.json
└── tsconfig.json
```

服务加载来源：先加载 `hile.auto_load_packages`（如有），再加载运行时目录下的 `*.boot.{ts,js}`。其余服务通过 `loadService` 按需加载。

## 开发

```bash
pnpm install
pnpm build
pnpm dev
```

## License

MIT
