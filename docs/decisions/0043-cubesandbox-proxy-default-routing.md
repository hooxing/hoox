# ADR-0043：CubeSandbox 数据面缺省路由

- 状态：已接受
- 日期：2026-07-28
- 关联：ADR-0004、ADR-0015、ADR-0040、ADR-0041

## 背景

CubeAPI 的 create、kill 和 probe 属于管理面；command、runCode 和 filesystem 则通过
`<sandbox-id>.cube.app` 虚拟域名进入 CubeProxy 数据面。受控 Node SDK 只有收到
`proxyNodeIp` 时才会保留虚拟 Host 并把 TCP 连接直连到 CubeProxy 节点。

真实 Web Run 已持久化 `tool.started`，对应一次性许可也均为 authorized、consumed，但四类 Sandbox
工具全部形成失败回执，最终 Workspace verifier 的 command 同样失败。直接使用
`cubeConfigFromEnv()` 的真实 Cube 冒烟通过；Worker 严格配置解析在 Proxy 环境变量缺失时却把
nodeIp、port、scheme 全部省略。此时 create/kill 仍可经 API 成功，而数据面会尝试普通 DNS 解析
虚拟域名并失败。

在不改代码、只显式设置 Proxy nodeIp 和 http 后，真实纯聊天与 sandbox_command Web Run 均完整
succeeded。因此本故障不是 250ms 本地许可 continuation 限制；不得借此放宽一次性许可的消费、
重放或副作用时间窗口。

## 备选方案

1. 把 Proxy 三项都改成必填配置，缺失时进程启动失败。边界最显式，但会破坏当前自托管单机默认值和
   已有 `.env`，并重复要求运维填写可由 CubeAPI URL 确定的节点。
2. 缺省时依赖 `*.cube.app` 的普通 DNS。无需代码改动，但不满足当前自托管部署的虚拟 Host 路由，
   已由真实 Run 证明会产生“管理面成功、数据面全失败”的半可用状态。
3. 统一推导规则：显式 Proxy 配置优先；nodeIp 缺失时取规范化 CubeAPI URL 的 hostname；scheme
   缺失且显式 port 为 443 时取 https，其余情况取 http；port 缺失时继续由 SDK 使用其既有默认值。

## 决策

采用方案 3。在 Sandbox 包提供唯一的 `resolveCubeProxyRouting()`，`cubeConfigFromEnv()`、Agent
Worker 和 Scheduler 的严格进程配置共同使用它。显式 nodeIp、port、scheme 始终覆盖推导值；仅显式
配置 port 时，scheme 推导必须与受控 SDK 的“443→https，其余→http”规则一致。

本决策只修复 CubeProxy 网络路由，不改变 Tool schema、Observation、一次性许可、重放、超时或
副作用调用顺序。Worker 仍把解析后的数据面配置显式传入 `CubeSandboxSessionRegistry`；不会让厂商
SDK从 Worker 全局环境隐式读取未受审变量。

## 影响

### 正面影响

- 缺省自托管配置下，管理面和数据面恢复为一致可用；四类 Sandbox 工具及最终 verifier 共用正确路由。
- 环境变量入口与严格进程入口不再产生不同的 CubeGateway 行为。
- 显式独立 CubeProxy 部署保持兼容。

### 负面影响与成本

- 缺省规则继续依赖“CubeAPI 与 CubeProxy 同机”的当前部署约束；独立节点必须显式配置。
- API 使用 https 不代表数据面也使用 https；数据面缺省仍是 http，只有显式 port=443 且 scheme
  缺失时才自动选择 https。

### 安全、数据与运维影响

- 不新增网络目标：缺省 nodeIp 仅来自已经过严格 URL 校验的 CubeAPI hostname。
- 不变更数据库或持久数据，无迁移；不输出 API key、上游异常或原始 Sandbox 内容。
- readiness 仍应覆盖真实数据面操作，避免只用管理面 probe 判断完全可用。

## 验证

- Sandbox 单元测试覆盖缺省推导、显式覆盖、仅显式 443 端口时推导 https，以及环境变量入口一致性。
- Worker 与 Scheduler process 配置测试断言缺省 nodeIp/scheme 已进入受审配置、部分显式配置可组合，
  且显式 scheme 优先于 443 默认。
- 使用真实 Worker process 配置解析结果构造 `CubeSandboxSessionRegistry`，创建临时 Sandbox，执行只读
  `printf` command 并校验 exitCode/stdout，最后 kill 清理。
- 全量 `pnpm check` 通过；真实 Web 回归应覆盖至少一个 sandbox_command Run 和最终 verifier。

## 可逆性

代码与配置推导可直接回退，无数据迁移和不可逆写入。若未来 CubeAPI 与 CubeProxy 默认不再同机，
应新增替代 ADR，将 Proxy 配置改为必填或从 CubeAPI 的受信服务发现响应获取；不能静默回到普通 DNS。

## 实施记录

- 2026-07-28：统一 Sandbox、Worker、Scheduler 的 Proxy 缺省解析，保持 SDK 的 443→https 规则，
  并增加真实只读 command 验证。
