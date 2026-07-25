# ADR-0004：全 TypeScript、Pi 与 CubeSandbox 技术边界

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M0-04、M0-05、M1-05、M5
- 替代关系：无

## 背景

Pi 已提供成熟的 Provider、流式输出、工具循环和会话控制，CubeSandbox v0.6 提供官方 Node SDK。继续保留 Python 控制面或自写完整 Agent Loop 会增加协议和恢复语义的重复实现，但把全部业务状态交给 Pi 又无法满足多租户和持久恢复要求。

## 决策驱动因素

- 共享领域类型、事件和工具协议，减少跨语言桥接；
- 利用成熟 Agent Kernel，避免重复处理 Provider 边角情况；
- 所有模型生成代码必须在 CubeSandbox 内执行；
- Runtime 必须掌握租户授权、状态机、外部副作用和恢复事实。

## 备选方案

### 方案 A：继续使用 Python Runtime，TypeScript 只做 Web

可复用原型，但需要跨语言协议，官方 Node SDK 和 Pi 也无法自然落在同一 Worker。

### 方案 B：全 TypeScript，Pi 为可替换 Kernel，CubeSandbox 走受控适配层

复用通用能力并保持业务控制权，但需要明确 Pi Session 与 Runtime Rollout 的双层语义。

### 方案 C：全 TypeScript 并自写 Agent Loop

控制最彻底，但 Provider、流式工具、多工具、中断和协议异常的维护成本高。

## 选择

采用方案 B。边界如下：

| 能力 | 责任方 |
|---|---|
| Provider、流式模型输出、工具调用循环、多工具、abort/steer/follow-up、协议适配 | Pi |
| Tenant、Thread、Run、Agent Tree、Lease、恢复、审计、Workspace、Resource、Artifact | Runtime |
| 系统提示词、Token 预算、工具输出截断、Compaction 和会话重建 | Runtime Context Policy |
| 工具授权、幂等、错误标准化和审计 | Runtime Tool Router |
| Sandbox 生命周期、命令、代码和文件底层调用 | `packages/sandbox` 封装的 CubeSandbox Node SDK |

Pi `AgentSession` 是 Worker 内的活动模型投影，不是生产事实源。Pi 本地 Session 文件不进入生产恢复链路。Pi 自带宿主机 Bash/read/write/edit 工具不注册；租户 Skill 不能作为 Pi Extension 在 Worker 加载。模型密钥、数据库密钥和 S3 密钥只存在于可信控制面，不进入 Sandbox。

API、Agent Worker、Scheduler 和 Web 可以起步时共同部署，但保持独立入口与包边界。所有新代码只在本仓库 `runtime-ts/` 内实现，不调用 Python。

## 理由

方案 B 将成熟通用能力和本项目特有的可靠性/租户语义分开。Pi 或 CubeSandbox SDK 将来可以通过适配层升级或替换，而领域数据不需要随之迁移。

## 影响

### 正面影响

- 模型、工具、API 和事件共享 TypeScript 类型；
- 可快速获得流式工具循环和 Provider 兼容能力；
- Sandbox 调用不需要 Python Sidecar。

### 负面影响与成本

- `pi-adapter` 必须稳定映射会话事件并处理版本升级；
- 需要维护 Pi Session Entry 与 Runtime Entry 的关联；
- 不能直接使用 Pi 开箱即用的宿主机工具和产品默认值。

### 安全、数据与运维影响

Worker 是可信高权限进程，必须以最小权限运行并限制出站网络。Sandbox 只接收执行任务真正需要的有限配置；工具参数在调用 SDK 前完成 Tenant、路径、大小和策略校验。

## 验证

- Fake Provider/Fake Sandbox 完成流式、多工具、abort、超时和协议错误契约；
- 真实纵向冒烟完成“Pi 自定义工具 → CubeSandbox 执行 → Observation 回到模型”；
- 测试断言 Pi 默认宿主机工具为空、Compaction 关闭、没有本地 Session 依赖；
- 凭据扫描证明 Sandbox 环境和事件中没有控制面秘密；
- 删除 Python 环境后仍可构建和运行新 Runtime。

## 可逆性与回退

在业务协议保持稳定的前提下，Pi 和 CubeSandbox 均可通过适配层替换。若业务代码绕过适配层直接使用其类型或 API，可逆性会显著下降，因此依赖边界检查属于合并 Gate。

## 后续工作

- 完成 M0-05 真实纵向冒烟；
- 为 Pi 和 CubeSandbox 建立版本契约套件；
- 在包依赖图中禁止 `apps` 反向依赖和业务包直连 vendored SDK。

## 实施记录

- Monorepo 空骨架和版本锁已建立；业务适配尚未实施。
