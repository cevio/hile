---
name: hile-cli
description: `@hile/cli` 的强约束生成规范。适用于 boot 编排、启动流程、容器事件日志与退出阶段管理。
---

# @hile/cli SKILL

本文档面向代码生成器与维护者，强调“可执行约束”，而非入门说明。

## 1. 强约束（必须遵守）

1. `hile.auto_load_packages` 只允许模块名，禁止文件路径。
2. boot 文件命名必须为 `*.boot.ts` / `*.boot.js`。
3. boot 文件必须 `export default` 合法 Hile 服务（`defineService` / `register` 结果）。
4. 加载顺序必须固定：`auto_load_packages` → 扫描 boot。
5. 运行目录优先级必须固定：`HILE_RUNTIME_DIR` → `src`(dev) → `dist`。
6. CLI 必须订阅 `container.onEvent` 并输出关键生命周期日志。
7. 进程退出时必须调用 `container.shutdown()`，并取消事件订阅。

## 2. 容器事件日志约束

最小事件集：

- `service:init`
- `service:ready`
- `service:error`
- `service:shutdown:start`
- `service:shutdown:done`
- `service:shutdown:error`
- `container:shutdown:start`
- `container:shutdown:done`
- `container:error`

要求：

- 保留原始错误对象
- 输出统一日志前缀（如 `[hile]`）
- 记录可用耗时字段（`durationMs`）

## 3. 反模式（禁止）

### 3.1 在 CLI 中重复实现容器语义

```typescript
// ✗ 不要在 CLI 内自建另一套生命周期/依赖管理

// ✓ 复用 @hile/core 的 onEvent、shutdown、resolve 语义
```

### 3.2 boot 文件导出普通函数或配置

```typescript
// ✗
export default function main() {}

// ✓
export default defineService(async (shutdown) => {
  // ...
})
```

### 3.3 忘记取消事件订阅

```typescript
// ✗ 只订阅不释放
const off = container.onEvent(listener)

// ✓ 退出时调用 off()
```

## 4. 边界条件清单

- [ ] 无可加载服务时打印 `no services to load` 并退出
- [ ] 非法默认导出时报错包含目标文件或模块标识
- [ ] `--dev` 与非 dev 的 `NODE_ENV` 行为一致
- [ ] 多个 `--env-file` 加载顺序可预测
- [ ] shutdown 期间异常不会吞掉主错误
