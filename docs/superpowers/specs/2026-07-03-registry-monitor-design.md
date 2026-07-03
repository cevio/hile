# @hile/registry-monitor 设计

## 背景

Hile registry 已经提供只读诊断接口，包括 `/-/registry/status`、`/-/namespaces`、`/-/namespace/peers`、`/-/topics`、`/-/topic/get`、`/-/configs` 和 `/-/config/get`。这些接口可以描述注册中心当前的连接、命名空间、topic 和配置状态，不需要改变现有注册、发现、发布订阅或配置逻辑。

本次目标是基于 Ink 做一个动态终端监控面板，用于连接已经运行的 registry，并实时展示注册中心状态。实现必须保持 `@hile/cli` 轻量：监控逻辑归属于新包 `@hile/registry-monitor`，CLI 只负责命令参数解析和调用。

## 用户接口

新增命令：

```bash
hile registry monitor --host 127.0.0.1 --port 9876 --interval 1000
```

参数：

- `--host <host>`：目标 registry 主机，默认 `127.0.0.1`。
- `--port <port>`：目标 registry 端口，默认 `9876`。
- `--interval <ms>`：刷新间隔，默认 `1000`，小于等于 0 时视为非法参数。

运行后进入 Ink TUI。用户可以按 `q` 退出，也可以使用 `Ctrl+C` 退出。命令只连接已有 registry，不负责启动 registry。

## 包边界

新增 `packages/registry-monitor`，发布名为 `@hile/registry-monitor`。

包内职责：

- 创建临时 `Server` 探针并连接目标 registry。
- 周期性读取 registry 只读接口。
- 将接口返回值归一化为适合 UI 的快照。
- 使用 Ink 渲染动态终端监控面板。
- 处理请求失败、连接失败、重试和退出。

`@hile/cli` 职责：

- 在现有 `registry` 命令树下新增 `monitor` 子命令。
- 解析 `--host`、`--port`、`--interval`。
- 调用 `runRegistryMonitor(options)`。
- 不包含监控数据结构、轮询逻辑或 Ink 组件。

## 对外 API

`@hile/registry-monitor` 暴露：

```ts
export interface RegistryMonitorOptions {
  host?: string;
  port?: number;
  interval?: number;
}

export function runRegistryMonitor(options?: RegistryMonitorOptions): Promise<void>;
```

内部可以拆分为数据采集层和 UI 层，但包外只需要稳定暴露运行入口。后续如果需要嵌入其他入口，再考虑暴露更细的采集 API。

## 数据流

1. `@hile/cli` 调用 `runRegistryMonitor({ host, port, interval })`。
2. `@hile/registry-monitor` 创建一个临时 `Server`，使用随机本地端口监听。
3. 探针连接目标 registry。
4. 轮询读取：
   - `/-/registry/status`
   - `/-/namespaces`
   - `/-/topics`
   - `/-/configs`
5. 将返回值合并为一次 `RegistryMonitorSnapshot`。
6. Ink 组件根据最新快照重新渲染。
7. 退出时关闭轮询定时器、断开连接并释放本地监听。

`/-/namespace/peers` 和 `/-/topic/get` 暂不作为每轮必读接口，避免面板在 namespace 或 topic 较多时制造过多请求。第一版使用 `/-/namespaces` 中的 peers 和 `/-/topics` 中的 summary 已经能覆盖实时监控主视图。未来可以给选中项增加详情读取。

## 界面

面板显示：

- 顶部：目标 registry 地址、连接状态、最后刷新时间、错误提示。
- 状态区：uptime、client 数、namespace 数、topic 数、config namespace 数。
- Namespace 区：按 namespace 排序展示 peer 数和 peer 地址。
- Topic 区：按 topic 排序展示 publisher 数、subscriber 数、是否有 retained data。
- Config 区：按 namespace 排序展示配置 key。

当请求失败时：

- 保留上一次成功快照。
- 顶部显示错误信息。
- 继续按 `interval` 重试。
- 如果从未成功过，则显示连接中或错误空态，而不是崩溃退出。

## 错误处理

- 无法连接 registry：显示连接失败并持续重试。
- 单轮读取失败：记录错误，保留上一次快照。
- 非法参数：CLI 在调用 monitor 前输出错误并以非零状态退出。
- 退出：`q`、`Ctrl+C` 或进程退出时释放本地探针资源。

所有 registry 访问必须是只读接口。不得调用 `/-/declare`、`/-/undeclare`、`/-/subscribe`、`/-/unsubscribe` 或任何会改变 registry 状态的接口。

## 测试策略

采用测试先行：

1. `@hile/registry-monitor` 数据采集测试：
   - 能从 fake registry 读取 status、namespaces、topics、configs 并生成快照。
   - 读取失败时保留上一次成功快照并记录错误。
   - 不调用写入或订阅类 registry 接口。
2. `@hile/registry-monitor` 参数测试：
   - 默认 host、port、interval 正确。
   - 非法 interval 被拒绝。
3. `@hile/cli` 轻量接入测试：
   - `registry monitor` 子命令把参数透传给 `runRegistryMonitor`。
   - CLI 测试 mock `@hile/registry-monitor`，不加载 Ink。
4. 构建验证：
   - `pnpm --filter @hile/registry-monitor test`
   - `pnpm --filter @hile/registry-monitor build`
   - `pnpm --filter @hile/cli test`
   - `pnpm --filter @hile/cli build`

Ink 布局只做关键文案和状态的轻量测试，不做大段终端快照，避免样式微调导致测试脆弱。

## 非目标

- 不实现 registry 管理后台。
- 不新增 registry 写接口。
- 不改变现有 registry 发现、topic、config 语义。
- 不在 `@hile/cli` 内实现监控业务逻辑。
- 不在第一版实现交互式选中 topic/config 查看 payload。

## 验收标准

- 用户可以运行 `hile registry monitor --host 127.0.0.1 --port 9876` 连接已有 registry。
- 面板能动态刷新 status、namespace、topic 和 config 摘要。
- registry 不在线时面板不崩溃，并持续显示错误与重试状态。
- `@hile/cli` 只新增命令接线，核心逻辑在 `@hile/registry-monitor`。
- 新包和 CLI 接入都有针对性测试和构建验证。
