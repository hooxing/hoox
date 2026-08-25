# Runtime 共享包

本目录保存领域、契约、运行时编排和基础设施适配。包之间通过 pnpm Workspace 依赖连接，不使用跨目录相对导入。

## 领域与契约

| 包 | 职责 |
| --- | --- |
| `domain` | 核心实体、品牌类型和状态机不变量 |
| `protocol` | HTTP DTO、事件、错误信封与运行时 Schema |
| `protocol-mapper` | Domain/Protocol 显式映射和公开错误归一化 |
| `run-contracts` | Worker 执行事实、端口和运行期契约 |

## Runtime 编排

| 包 | 职责 |
| --- | --- |
| `pi-adapter` | 模型 Provider、流式会话和 Pi 适配 |
| `prompt-builder` | 稳定、可审计的系统提示词组装 |
| `context-policy` | 上下文预算、选择和压缩 |
| `tool-router` | 工具能力、路由、审计和错误边界 |
| `automation` | Thread 自动化与定时任务契约 |
| `memory` | Memory 端口和作用域 |
| `thread-title` | Thread 标题生成逻辑 |
| `trajectory` | 内部轨迹模型和转换 |

## 文件、资源与沙箱

| 包 | 职责 |
| --- | --- |
| `workspace` | Workspace 清单、Revision、租约和物化计划 |
| `resource` | Resource 发现、导入和不可变版本 |
| `artifact` | 最终交付物发布、完成和授权 |
| `sandbox` | CubeSandbox、E2B 等 Provider 适配 |
| `skill` | Skill 包、版本和目录边界 |

## 基础设施

| 包 | 职责 |
| --- | --- |
| `persistence` | PostgreSQL、迁移、事务、Outbox 和 S3/MinIO |
| `process-runtime` | 配置、健康、信号、排空和关闭 |

应用入口只装配这些包。Domain 与 Protocol 有意解耦；宿主机命令和工作目录访问必须经过 Tool Router 与 Sandbox 边界。

完整依赖和常见改动落点见 [`docs/architecture/repository-map.md`](../../docs/architecture/repository-map.md)。
