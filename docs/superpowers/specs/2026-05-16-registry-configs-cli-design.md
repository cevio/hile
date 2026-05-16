---
title: "Registry Configs CLI"
description: "为 hile CLI 添加 registry configs 子命令，实现 YAML 配置文件的管理：查看、设置、删除"
---

## 目标

为 `hile registry` 添加 `configs` 子命令体系，让用户可以通过 CLI 管理 `~/.registry/configs/*.config.yaml` 文件，而无需直接编辑 YAML 文件。

## 背景

Registry 已支持从 `~/.registry/configs/<namespace>.config.yaml` 加载配置，并通过 `fs.watch` 热加载文件变化。但缺少 CLI 管理接口，用户需要手动创建/编辑 YAML 文件。

## 方案 B（选定）

从 `@hile/micro` 导出配置路径工具函数，CLI import 后直接操作文件。简单轻量，路径逻辑集中。

## 详细设计

### 1. @hile/micro：新增导出工具函数

**文件：** `packages/micro/src/registry.ts`

```typescript
export function getRegistryConfigsDir(): string {
  return resolve(homedir(), '.registry', 'configs');
}

export function namespaceToConfigFile(ns: string): string {
  return join(getRegistryConfigsDir(), `${ns}.config.yaml`);
}

export function parseConfigFilename(filename: string): string | null {
  const suffix = '.config.yaml';
  if (!filename.endsWith(suffix)) return null;
  return filename.slice(0, -suffix.length);
}
```

`watchEnvFile()` 内部改用 `parseConfigFilename` 复用解析逻辑。

### 2. CLI 命令结构

**文件：** `packages/cli/src/index.ts`

```
hile registry                         # 启动 Registry（向后兼容）
hile registry --port 8888             # 启动 Registry 指定端口

hile registry configs                               # 列出所有 namespace
hile registry configs get <namespace>               # 获取配置（YAML 输出）
hile registry configs get <namespace> --json        # 获取配置（JSON 输出）
hile registry configs set <namespace> <key>=<value> # 设置配置项
hile registry configs del <namespace>               # 删除整个 namespace
hile registry configs del <namespace> <key>         # 删除某个字段
hile registry configs del <namespace> -y            # 跳过确认删除
```

Commander 实现方式：`registryCmd` 保留现有 `.option()` + `.action()`，通过 `.command('configs')` 添加子命令组。Commander 允许同一命令既有 action 又有 subcommands，当无子命令匹配时触发 action。

### 3. 各命令行为

#### `hile registry configs`（无参）

- 扫描 `configs/` 目录下所有 `*.config.yaml` 文件
- 提取 namespace 并列出
- 输出示例：
  ```
  Configs in ~/.registry/configs/:
    my-service
    database
    cache
  ```

#### `hile registry configs get <namespace>`

- 定位 `configs/<namespace>.config.yaml`
- 读取并解析 YAML
- 默认 YAML 格式输出，`--json` 输出 JSON
- 文件不存在时打印错误并 `process.exit(1)`

#### `hile registry configs set <namespace> <key>=<value>`

- 解析 `key=value`，等号左侧为 key，右侧为 value
- 值类型自动推断：
  - `true` / `false` → boolean
  - `null` → null
  - 纯数字（含小数）→ number
  - 其余保持 string
- 文件不存在时自动创建
- 读取现有配置 → 更新 key → YAML.stringify 写回

#### `hile registry configs del <namespace> [key]`

- 无 `key`：删除整个 `<namespace>.config.yaml` 文件
- 有 `key`：读取 YAML，删除该字段，写回（结果为空对象时删除文件）
- 使用 `readline.createInterface` 交互式确认 `(y/N)`
- `-y / --yes` 跳过确认

### 4. 确认机制

使用 Node.js `readline` 模块：

```typescript
async function confirm(message: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`${message} (y/N) `, answer => {
      rl.close();
      resolve(answer === 'y' || answer === 'Y');
    });
  });
}
```

确认提示：
- `del my-svc` → `Delete config 'my-svc' and all its values? (y/N)`
- `del my-svc port` → `Delete 'my-svc.port' from config? (y/N)`

### 5. 文件操作原则

- **set 不存在 namespace**：自动创建 YAML 文件
- **del 最后一个 key**：YAML 文件自动删除（不留空文件）
- **写入使用 `YAML.stringify`**：保持与读取一致的格式
- **错误处理**：文件读写异常直接 throw（自然展示错误栈）

### 6. 测试

**新增工具函数测试**（在 `packages/micro/src/env-config.test.ts` 中）：

| 测试 | 说明 |
|------|------|
| `getRegistryConfigsDir` 返回路径以 `.registry/configs` 结尾 | 验证路径拼接正确 |
| `namespaceToConfigFile` 生成带 `.config.yaml` 后缀的路径 | 验证文件名规约 |
| `parseConfigFilename` 匹配合法文件名并提取 namespace | 正例 |
| `parseConfigFilename` 非 `.config.yaml` 后缀返回 null | 反例 |

### 7. 向后兼容

- `hile registry --port 9876` 启动 Registry — **完全不变**
- `@hile/micro` 新增导出函数，不修改任何现有接口
- `Registry` 类自身行为不变，`watchEnvFile()` 逻辑不变（仅重构文件名解析）

## 未纳入范围

- 远程 Registry 操作（CLI 只操作本地文件系统）
- 动态配置（push 广播等后续讨论）
