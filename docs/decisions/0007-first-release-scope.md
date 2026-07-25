# ADR-0007：首个可发布版本范围与后置能力

- 状态：已接受
- 日期：2026-07-26
- 决策者：项目架构审阅
- 关联任务：M1 至 M8
- 替代关系：无

## 背景

目标架构包含团队、Memory、真实线上文件、丰富预览、动态 Sandbox 保温和子 Agent 等大量能力。一次实现全部能力会延迟核心闭环，也会在基础语义不稳定时扩大返工面。

## 决策驱动因素

- 优先交付个人用户可以长期对话、处理文件并下载结果的可靠闭环；
- 租户隔离、恢复和交付正确性不能以后补；
- 体验性优化和外部连接器可以在稳定数据模型上增量建设；
- Python 原型没有需要在线兼容的数据。

## 备选方案

### 方案 A：一次性交付目标架构全部能力

功能完整，但关键路径过长，真实风险无法分阶段隔离。

### 方案 B：以 Gate 递进完成个人租户核心，再接高级能力

每阶段可独立验证，首版仍包含 Skill 和显式子 Agent，但它们必须在单 Agent 主链路稳定后通过独立 Gate。

### 方案 C：只做单次 Run 演示

最快，但无法验证 Thread 连续性、跨 Thread 文件和可靠交付，不符合产品目标。

## 选择

采用方案 B。首个可发布版本包含：

- 个人 Tenant、可信 Tenant Context、Thread、多次 Run 和流式界面；
- 按需 Sandbox、不可变 WorkspaceRevision、同 Thread 连续性和固定 10 分钟 warm 策略；
- 上传、历史 Resource、搜索/局部预览/快照导入、Agent 显式提升；
- FileSource 协议与 Fake Provider，不连接真实线上服务；
- Agent 显式 Artifact 发布和所有允许类型的可靠下载，在线预览不作为 Gate；
- PostgreSQL + 私有 S3、追加式 Rollout、Lease、幂等、恢复和自有 Context Policy；
- Tenant 级 Skill 渐进加载和默认 `explicit_request_only` 的子 Agent，在核心闭环后经 M6 独立验收；
- 配额、安全、故障、可观测和供应链发布 Gate。

后置能力包括：团队租户和协作、长期 Memory、真实 FileSource、用户手动提升、丰富 Artifact 在线预览、动态 TTL/费用优化、Workspace 分支合并和复杂角色权限。旧 Run、旧 Artifact、JSON/JSONL 和 `workspace.tar.gz` 永不作为兼容范围。

## 理由

该范围保留用户最重要的连续工作和最终交付体验，同时把外部依赖与体验优化放到稳定领域模型之后。Skill 和子 Agent 不阻塞单 Agent 核心开发，但仍由首版生产 Gate 管理。

## 影响

### 正面影响

- 每个阶段都有可运行结果和明确退出条件；
- Memory、预览和第三方连接器不会拖累核心发布；
- 完全新建目录，旧 Python 不形成技术债延续。

### 负面影响与成本

- 首版部分文件只有下载，没有内嵌预览；
- 用户不能直接点击把过程文件提升为 Resource；
- FileSource 产品体验和长期个性化需要后续版本。

### 安全、数据与运维影响

后置功能不能通过隐藏入口提前绕过 Tenant Context。Feature Flag 默认关闭且不能改变已发布对象的所有权。

## 验证

- 每个阶段必须通过 [路线图](../roadmap.md) 中对应 Gate 才能进入下一阶段；
- 生产发布前完成两个租户越权矩阵、Worker/DB/S3/Sandbox 故障演练和依赖扫描；
- 检查构建与运行环境不包含 Python 依赖或旧数据读取；
- 任何提前引入后置能力的任务必须有替代 ADR。

## 可逆性与回退

后置能力和可选 M6 能力可以通过 Feature Flag 回退。Tenant/Thread/版本对象和持久化边界属于核心数据契约，不得以“缩小首版”为由回退。

## 后续工作

- 按路线图逐阶段推进并更新 Gate 证据；
- 首版运行数据稳定后，分别为 Memory Provider、首个真实 FileSource 和预览管线新增 ADR。

## 实施记录

- 已确定范围，业务能力尚未实施。
