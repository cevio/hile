# ADR-0002: 将 @hile/core 升级为应用编排内核

## 背景

原容器已有单例、并发合并、shutdown，但在生命周期可观测性、超时控制、依赖图与循环依赖治理方面能力不足。

## 决策

在 `@hile/core` 增加：

1. 显式生命周期：`init -> ready -> stopping -> stopped`
2. 启动/销毁超时：`startTimeoutMs`、`shutdownTimeoutMs`
3. 事件流：`onEvent/offEvent` 与标准事件集
4. 依赖图导出：`getDependencyGraph()`
5. 启动顺序导出：`getStartupOrder()`
6. 循环依赖检测：运行时检测并抛错

## 影响

正向：

- CLI/HTTP/集成包共享一致容器语义
- 可观测性显著提升
- 复杂依赖关系更容易治理

代价：

- 容器实现复杂度上升
- 需要补充测试与文档同步

## 备选方案

1. 仅在 CLI 层做日志：无法统一语义
2. 外挂第三方编排器：侵入大、心智成本高
