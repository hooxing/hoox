# Spike 记录

Spike 是特定提交、环境和时间点的实验或能力证据，不自动构成当前实现说明或生产保证。

| 文档 | 何时使用 | 不能证明什么 |
| --- | --- | --- |
| [Thread 连续上下文阶段 0 能力 Spike](2026-07-31-thread-context-capability-spikes.md) | 追溯连续上下文方案形成前的依赖能力核对 | 当前 Thread 连续上下文仍按当时限制运行 |
| [Pi + CubeSandbox 纵向验证](pi-cube-vertical.md) | 追溯 Pi 与 CubeSandbox 初始纵向链路的实验结果 | 当前 Provider、版本或生产环境持续可用 |

当前行为见[架构文档](../architecture/README.md)，持续保证由自动化测试和 CI 提供。
