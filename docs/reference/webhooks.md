# Webhook 接收与管理参考

本文面向配置 Tenant Webhook 的管理员和实现接收端的开发者，说明当前事件、载荷、签名、停用和重试契约。

## 管理入口与权限

Webhook 用于 Hoox 在 Run 完成等事件发生时通知部署方系统。平台管理员在后台「接入 → Webhook」选择目标空间，注册公网 HTTPS 地址、选择事件订阅、轮换密钥、停用或删除订阅，并查看停用时间和原因。选择器默认定位初始化管理员的个人空间；只有为特定用户或团队空间单独接入时才选择其他空间。普通工作台不提供管理入口；Tenant Owner/Admin 或持有 `webhooks:manage` 的服务 Key 不获得后台管理权。

管理接口使用既有后台管理员身份，前缀为 `/v1/admin/control/integrations/:tenantId/webhooks`；完整路由与审计边界见[后台接入管理](../architecture/admin-control-plane.md#接入管理边界)。用户 API 不注册 `/v1/webhooks` 管理路由。当前没有投递记录查询接口或页面，列表展示订阅状态与停用原因，不等同于逐次投递历史。

## 事件

订阅类型为 `run.waiting`、`run.requires_action`、`run.succeeded`、`run.failed`、`run.cancelled`、`artifact.published`。`run.requires_action` 专指客户端工具等待事实；普通 `waiting` 不会被解释为该事件。每个待处理调用产生一个事件；同一次等待也会产生普通状态事件 `run.waiting`。

Run 事件覆盖所有提交 Run 状态转换的路径：Worker 收尾、API 取消、过期 Attempt 的安全失败恢复以及团队解散时的批量取消。事件与状态转换在同一事务提交；事务回滚则不产生事件。

## 载荷

载荷字段为封闭白名单，平台不自动附加附件字节、文件名、路径或下载 URL：

| 事件 | 字段 |
| --- | --- |
| `run.waiting`、`run.succeeded`、`run.failed`、`run.cancelled` | `id`、`type`、`createdAt`、`data.runId`、`data.status` |
| `run.requires_action` | `id`、`type`、`createdAt`；`data` 包含 `threadId`、`runId`、`callId`、`toolName`、`arguments`、`deadline` |
| `artifact.published` | `id`、`type`、`createdAt`、`data.artifactId`、`data.runId` |

工具参数由模型提供，可能含敏感业务数据。仅向有权接收参数的服务订阅 `run.requires_action`；不要记录原始载荷。投递可能迟到或重复，开始操作前检查截止时间和 Run 状态；取消或超时不会撤销外部已经发生的副作用。验签、去重后按[公开 API](public-api.md#执行客户端工具并回传)提交结果。

事件 `id` 由业务事实确定性派生：同一 Run 状态转换、同一客户端工具调用或同一 Artifact 发布在同一 Tenant 的所有订阅间使用同一 ID，重放不会产生新 ID；单个订阅对同一事件最多有一条投递记录。`createdAt` 为业务事实提交时间。

## 签名验证

请求通过 `X-Hoox-Event-Id`、`X-Hoox-Timestamp` 和 `X-Hoox-Signature` 传递事件 ID、Unix 毫秒时间戳和版本化签名。正文按 UTF-8 原始字节计算 SHA-256。签名输入为以下四行，以 LF（`\n`）连接，末尾不带换行：

```text
hoox-webhook-v1
<TIMESTAMP>
<EVENT_ID>
<SHA256_HEX_OF_BODY>
```

签名值为 `v1=` 加上 `HMAC-SHA256(secret, signing-input)` 的小写十六进制编码。接收端应在验签前保留原始正文，不得先解析再重新序列化；比较 MAC 时使用常数时间比较。时间戳应限制在接收端允许的短时窗口内，并以事件 ID 做原子幂等去重。

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, eventId: string, timestamp: string, header: string, secret: string) {
  if (!/^\d{13}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(header)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const input = `hoox-webhook-v1\n${timestamp}\n${eventId}\n${digest}`;
  const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(input).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

可用以下固定向量自测验签实现（验证时需把当前时间视为时间戳附近）：

| 项 | 值 |
| --- | --- |
| 密钥 | `whsec_example_fixed_vector` |
| 时间戳 | `1767225600000` |
| 事件 ID | `evt_example` |
| 正文 | `{"id":"evt_example","type":"run.succeeded","createdAt":"2026-01-01T00:00:00.000Z","data":{"runId":"run_example","status":"succeeded"}}` |
| 签名 | `v1=bf1039d0e4342e38fd922a4d47d065da575799b5a320e474727743c6e1e6dff1` |

## 投递语义

Outbox 在业务状态事务中写入，只保存事件快照，不保存目的地址或签名密钥。Scheduler 使用专属数据库角色领取并结算 Outbox；该角色只能读取订阅的投递列（地址、密钥密文和停用状态），不能查询 Run、Thread、Membership 或 Tenant 表。投递为至少一次：网络响应丢失或进程在远端接收后崩溃时，事件可能再次发送。接收端必须把事件 ID 的登记与业务副作用放在同一事务中实现去重。

每次投递：领取并计入一次尝试，校验目标地址，发送前复核订阅仍启用并读取当前密钥，然后签名发送。DNS 解析、连接、TLS 握手与完整响应共用一个 10 秒绝对时限，短于 30 秒领取租约；超时、连接或响应错误、响应不完整、响应超过 64 KiB 都按失败结算。只有完整读取的 2xx 响应视为送达；3xx 不跟随。HTTP 只允许 HTTPS 和经过校验的公网地址，每次投递新建连接并直拨已校验 IP，不复用连接池、不经过代理，证书与 SNI 按原主机名校验，`Host` 保留原 URL 的主机部分。单个 Scheduler 进程并发投递有上限，同一 Tenant 同时最多占用一个并发槽位，慢接收端不会阻塞其他 Tenant。

DNS 使用可取消的独立解析器，不占用 `getaddrinfo` 共享线程池；每进程最多同时解析 16 个域名，A 与 AAAA 查询都结束后才释放配额，任何一个结果不满足地址规则都会拒绝目标。注册解析的截止时间不超过 3 秒且短于 handler 时限，同时响应请求取消；取消后的迟到解析结果不会创建订阅。

失败使用指数退避，每条事件最多尝试 12 次。次数上限在领取时强制：进程在最后一次尝试结算前崩溃，租约到期后该事件直接进入终态，不会发送第 13 次。任何事件耗尽次数都会自动停用整个 Webhook，管理列表显示停用原因 `delivery_attempts_exhausted`。

手动或自动停用都作用于整个订阅：停用提交后不再入队新事件，也不再领取该订阅已排队的积压。停用前已领取、尚未通过发送前复核的投递不会发出；持有有效租约的 Dispatcher 在复核时发现订阅已停用，会将该条记录标为 `webhook_disabled`。已通过复核、正在发送的那一次请求可能仍会到达。停用不可撤销，需删除并重新注册以恢复订阅。

轮换密钥只更新订阅；所有之后通过发送前复核的投递（包括积压和重试）都使用新密钥。只有轮换提交时已经通过复核的在途请求可能使用旧密钥（多个 Scheduler 实例可能各有在途请求），接收端可在切换后短暂同时接受新旧密钥。

Webhook 密钥仅创建或轮换时返回一次。数据库只保存用途隔离的 AES-256-GCM 密文；Admin Control 与 Scheduler 使用相同的独立 `WEBHOOK_SECRET_ENCRYPTION_KEY` 根密钥，用户 API 与 Worker 不接收该根密钥。未配置时后台的注册与密钥轮换失败关闭，不影响 API Key 管理。

管理 API 的删除采用逻辑删除：订阅从列表隐藏，后续新事件不再选择该订阅，积压不再领取；发送前复核及在途请求遵循停用的边界。删除不可恢复，再次删除、停用或轮换均视为不存在。数据库保留订阅与 Outbox，避免并发事件的外键检查回滚业务状态；物理回收约束见[持久化与数据库](../architecture/persistence-and-database.md#outbox-与后台消费)。
