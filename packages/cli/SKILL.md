---
name: hile-cli
description: @hile/cli 的项目结构与一键启动编排规范。适用于 boot 文件组织、package.json 配置、运行时目录与启动流程相关场景。
---

# @hile/cli SKILL

本文档约束 `@hile/cli` 场景下的项目组织方式，确保应用可通过 `hile start` / `hile start --dev` 一键启动。

## 1. 目标

- 用结构约定替代手写入口聚合
- 用 `*.boot` 与 `hile.auto_load_packages` 描述启动编排
- 保证开发与生产路径一致可预期

## 2. 推荐目录结构

```text
<project-root>/
├── src/
│   ├── *.boot.ts
│   └── services/
├── dist/
├── package.json
└── tsconfig.json
```

规则：

- 需要“随进程启动”的服务放在运行时目录并命名为 `*.boot.ts/js`
- 仅被依赖的服务放在 `services/`，不要加 `.boot`

## 3. 运行时目录优先级

1. `HILE_RUNTIME_DIR`
2. `hile start --dev` → `src/`
3. `hile start` → `dist/`

## 4. package.json 约定

### 4.1 `hile.auto_load_packages`

```json
{
  "hile": {
    "auto_load_packages": ["@hile/http", "my-local-service"]
  }
}
```

规则：

- 数组项必须是模块名，不可写文件路径
- 加载顺序：先 `auto_load_packages`，再扫描 `*.boot.{ts,js}`
- 模块默认导出必须是合法 Hile 服务（通过 `isService`）

### 4.2 scripts 建议

```json
{
  "scripts": {
    "start": "hile start",
    "dev": "hile start --dev",
    "build": "tsc -b"
  }
}
```

## 5. Boot 文件规范

```typescript
import { defineService, loadService } from '@hile/core'
import { configService } from './services/config'

export default defineService(async (shutdown) => {
  const config = await loadService(configService)
  const app = await createApp(config)
  shutdown(() => app.close())
  return app
})
```

要求：

- 文件名后缀必须是 `.boot.ts` 或 `.boot.js`
- 必须有 `default` 导出
- 默认导出值必须来自 `defineService` 或 `container.register`

## 6. 命令速查

| 命令 | 说明 |
|---|---|
| `hile start` | 生产模式，`NODE_ENV=production` |
| `hile start --dev` | 开发模式，`NODE_ENV=development`，扫描 `src/` |
| `hile start -e .env -e .env.local` | 按顺序加载 env 文件 |
| `hile -v` | 版本 |
| `hile -h` | 帮助 |

## 7. 编排检查清单

- [ ] boot 文件仅用于进程入口服务
- [ ] boot 文件位于运行时目录并命名正确
- [ ] 每个 boot 文件 default 导出合法服务
- [ ] `auto_load_packages` 仅包含模块名
- [ ] `dev` / `start` 脚本与 CLI 行为一致
