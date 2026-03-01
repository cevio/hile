---
name: hile-cli
description: Project structure, boot file conventions, and one-click dev workflow for @hile/cli. Use when scaffolding or organizing Hile apps, adding *.boot files, configuring package.json for hile start, or when the user asks about @hile/cli, hile start, boot files, or Hile project layout.
---

# @hile/cli

`@hile/cli` 为基于 `@hile/core` 的应用提供**一键启动**能力。本文档面向编辑器和 AI 大模型，约定**项目结构**与**项目编排方式**，确保生成的代码和目录布局符合 CLI 的加载规则，便于一键开发。

---

## 1. 目标与原则

- **一键启动**：在项目根目录执行 `hile start` 或 `hile start --dev` 即可加载并运行所有服务，无需手写入口聚合逻辑。
- **结构即约定**：服务通过 **boot 文件**（`*.boot.ts` / `*.boot.js`）和 **package.json 的 `hile.auto_load_packages`** 声明；目录结构和命名直接决定加载顺序与范围。
- **编排优先**：新增可执行服务时，应优先考虑「放在哪、叫什么、以何种方式被加载」，再编写具体实现。

---

## 2. 项目结构规范

### 2.1 推荐目录布局

生成或建议项目结构时，应遵循以下布局（或等价变体）：

```
<project-root>/
├── src/                          # 开发时代码与 boot 文件所在目录（--dev 时扫描）
│   ├── *.boot.ts                 # 自启动服务入口（见 2.2）
│   └── services/                 # 非自启动服务（被 boot 或其他服务 loadService 引用）
│       ├── config.ts
│       ├── database.ts
│       └── ...
├── dist/                         # 生产构建输出（未指定 HILE_RUNTIME_DIR 时扫描）
├── package.json                  # 含 scripts 与可选 hile 配置
└── tsconfig.json
```

**规则：**

- **Boot 文件** 放在 **运行时目录** 下（开发时为 `src/`，生产时为 `dist/`），以便 CLI 通过 `**/*.boot.{ts,js}` 扫描。
- **仅被依赖、不主动启动的服务** 放在 `services/`（或其它子目录），通过 `defineService` 定义，由 boot 文件或其它服务内 `loadService` 引用；**不要** 为纯被依赖服务创建 boot 文件。
- 根目录保留 `package.json`，便于 CLI 读取 `hile.auto_load_packages` 并解析工作目录。

### 2.2 运行时目录

CLI 确定「从哪一目录扫描 boot 文件」的优先级：

1. 环境变量 **`HILE_RUNTIME_DIR`**（若已设置）
2. **开发模式**（`hile start --dev`）→ `src/`
3. **生产模式**（`hile start`）→ `dist/`

生成脚本、文档或配置时：

- 开发命令统一使用 `hile start --dev`，对应 `src/`。
- 生产环境若需自定义目录，应说明设置 `HILE_RUNTIME_DIR`（例如 `HILE_RUNTIME_DIR=./dist`）。

---

## 3. package.json 配置

### 3.1 hile.auto_load_packages

在项目根目录的 `package.json` 中可增加可选字段 `hile.auto_load_packages`，用于在**扫描 boot 文件之前**先加载指定**模块**的默认导出为服务：

```json
{
  "name": "my-app",
  "hile": {
    "auto_load_packages": ["@hile/http", "my-local-service"]
  }
}
```

**代码生成与审查规则：**

| 规则 | 说明 |
|------|------|
| 数组元素必须是**模块名** | 与 `import('模块名')` 一致，**不能**写相对路径或绝对路径（如 `./src/foo`） |
| 加载顺序 | 先按数组顺序加载 `auto_load_packages`，再按扫描结果加载运行时目录下的 `*.boot.{ts,js}` |
| 默认导出契约 | 每个模块的 **default 导出** 必须是通过 `defineService` 或 `container.register` 返回的 `ServiceRegisterProps`，能通过 `isService` 校验 |
| 可选配置 | 不配置 `hile` 或 `auto_load_packages` 时，仅通过 boot 文件加载服务 |

典型用法：将 `@hile/http` 等「包内已提供默认服务导出」的依赖放入 `auto_load_packages`，实现「先起框架再起业务 boot」的编排。

### 3.2 脚本约定

推荐在 `package.json` 的 `scripts` 中统一命名，便于 AI 与开发者执行：

```json
{
  "scripts": {
    "start": "hile start",
    "dev": "hile start --dev",
    "build": "tsc -b"
  }
}
```

- `dev`：开发模式，扫描 `src/`，使用 tsx 运行 TypeScript。
- `start`：生产模式，扫描 `dist/`，需先执行 `build`。

---

## 4. Boot 文件规范

### 4.1 命名与位置

- **文件名**：必须以 `.boot.ts` 或 `.boot.js` 结尾，且位于运行时目录（或其子目录）下。
- **扫描模式**：`**/*.boot.{ts,js}`，即所有子目录中的 boot 文件都会被加载；可通过目录划分不同领域（如 `src/http.boot.ts`、`src/workers/queue.boot.ts`）。

### 4.2 导出契约

每个 boot 文件**必须**默认导出一个通过 `defineService`（或 `container.register`）定义的服务，且该导出能通过 `isService` 校验。

**模板（无额外依赖）：**

```typescript
// src/example.boot.ts
import { defineService } from '@hile/core'

export default defineService(async (shutdown) => {
  // 初始化资源
  const resource = await createResource()
  shutdown(() => resource.close())
  return resource
})
```

**模板（依赖其他服务）：**

```typescript
// src/http.boot.ts
import { defineService, loadService } from '@hile/core'
import { configService } from './services/config'

export default defineService(async (shutdown) => {
  const config = await loadService(configService)
  const app = await createHttpServer(config)
  shutdown(() => app.close())
  return app
})
```

**禁止：**

- 默认导出非服务对象（如普通函数、类实例、纯配置对象）。
- 无 `default` 导出或导出为 `undefined`。

服务实现细节（如 shutdown 注册顺序、异步初始化）遵循 `@hile/core` 的 SKILL 与类型约定；此处仅约定「boot 文件作为入口」的形态。

### 4.3 与「被依赖服务」的区分

- **Boot 文件**：表示「应用启动时就要加载的服务」，通常对应进程级单例（HTTP 服务、数据库连接池、消息队列连接等）。
- **非 boot 服务**：仅被其他服务或 boot 通过 `loadService` 使用，不直接作为进程入口。应放在 `services/` 等目录，**不要** 为其添加 `.boot.ts`，避免重复或循环加载。

AI 生成新服务时，应先判断该服务是「进程入口」还是「被依赖能力」再决定是新增 boot 文件还是普通服务模块。

---

## 5. 命令与选项

生成文档或脚本时，应使用以下命令与选项表述（与当前 CLI 一致）：

| 命令 | 说明 |
|------|------|
| `hile start` | 生产模式：`NODE_ENV=production`，运行时目录为 `dist/` |
| `hile start --dev` | 开发模式：`NODE_ENV=development`，tsx 运行 TS，运行时目录为 `src/` |
| `hile start -e .env -e .env.local` | 按顺序加载 env 文件（先加载的不被后加载覆盖），依赖 Node 20.12+ `process.loadEnvFile()` |
| `hile -v` / `hile --version` | 显示版本号 |
| `hile -h` / `hile --help` | 显示帮助 |

---

## 6. 类型与依赖关系

- **服务定义与加载**：完全依赖 `@hile/core` 的 `defineService`、`loadService`、`isService`、`ServiceRegisterProps`。生成 boot 或服务代码时，须符合 core 的 SKILL（类型签名、异步、shutdown 注册、禁止缓存 loadService 到模块顶层的规则等）。
- **CLI 行为**：CLI 仅负责按顺序解析 `hile.auto_load_packages` 与 `**/*.boot.{ts,js}`，对每个条目执行「默认导出 → isService 校验 → loadService」，并在进程退出时调用 `container.shutdown()`。不关心具体业务类型，只要求导出满足 `ServiceRegisterProps` 契约。

---

## 7. 编排检查清单（供 AI 自检）

在生成或修改与「一键启动」相关的代码时，可依此清单核对：

- [ ] Boot 文件仅用于「需要随进程启动」的服务；纯被依赖服务未误加 `.boot.ts`。
- [ ] 所有 boot 文件位于运行时目录（`src/` 或 `dist/` 或 `HILE_RUNTIME_DIR`）下，且命名为 `*.boot.ts` 或 `*.boot.js`。
- [ ] 每个 boot 文件有且仅有一个 `default` 导出，且为 `defineService` / `container.register` 的返回值。
- [ ] `package.json` 中 `hile.auto_load_packages` 的每一项为模块名，无路径形式。
- [ ] 项目根目录存在 `package.json`，且 `scripts.dev` / `scripts.start` 与文档或脚本中的 `hile start` 用法一致。
- [ ] 服务间依赖通过 `loadService` 在服务函数内部完成，未在模块顶层缓存 `loadService` 结果。

---

## 8. 相关资源

- **@hile/core**：服务定义、`loadService`、shutdown 与容器语义见该包的 SKILL 与 README。
- **@hile/http**：若项目使用 HTTP 服务框架，其默认导出可作为 `hile.auto_load_packages` 的一项，HTTP 路由与控制器约定见该包的 SKILL。
- **@hile/typeorm**：若使用 TypeORM 作为数据访问层，DataSource 服务、事务辅助与仓储模式约定见该包的 SKILL。
- **@hile/ioredis**：若使用 Redis 作为缓存或消息中间件，连接管理与服务封装约定见该包的 SKILL。
