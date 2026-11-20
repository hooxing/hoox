# Webhook 接收与管理参考

本文面向配置 Tenant Webhook 的管理员和实现接收端的开发者，说明当前事件、签名和重试契约。

## 事件

订阅类型为 `run.waiting`、`run.requires_action`、`run.succeeded`、`run.failed`、`run.cancelled`、`artifact.published`。`run.requires_action` 专指客户端工具等待事实；普通 `waiting` 不会被解释为该事件。客户端工具等待事件由 C4 在写入等待事实的同一事务产生，因此在 C4 接入前不能订阅到该类投递。

每个事件包含稳定的 `id`、`type`、`createdAt` 与 `data`。Artifact 事件只提供 Artifact 标识与 Run 标识，不包含签名下载 URL。事件 ID 在同一 Tenant 的所有订阅间保持不变，单个订阅对同一事件最多有一条 Outbox 记录。

## 签名验证

请求通过 `X-Hoox-Event-Id`、`X-Hoox-Timestamp` 和 `X-Hoox-Signature` 传递事件 ID、Unix 毫秒时间戳和版本化签名。正文按 UTF-8 原始字节计算 SHA-256。签名输入为以下 UTF-8 行文本：

```text
hoox-webhook-v1\n<TIMESTAMP>\n<EVENT_ID>\n<SHA256_HEX_OF_BODY>
```

签名值为 `v1=` 加上 `HMAC-SHA256(secret, signing-input)` 的小写十六进制编码。接收端应在验签前保留原始正文，不得先解析再重新序列化；比较 MAC 时使用常数时间比较。时间戳应限制在接收端允许的短时窗口内，并以事件 ID 做原子幂等去重。

```ts
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

function verify(rawBody: Buffer, eventId: string, timestamp: string, header: string, secret: string) {
  if (!/^\\d{13}$/.test(timestamp) || !/^v1=[0-9a-f]{64}$/.test(header)) return false;
  if (Math.abs(Date.now() - Number(timestamp)) > 5 * 60_000) return false;
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const input = `hoox-webhook-v1\\n${timestamp}\\n${eventId}\\n${digest}`;
  const expected = Buffer.from(`v1=${createHmac("sha256", secret).update(input).digest("hex")}`);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
```

## 投递语义

Outbox 在业务状态事务中写入。Scheduler 使用专属数据库角色领取并结算 Outbox；该角色不能查询 Run、Thread、Membership 或 Tenant 表。投递为至少一次：网络响应丢失或进程在远端接收后崩溃时，事件可能再次发送。接收端必须把事件 ID 的登记与业务副作用放在同一事务中实现去重。

投递失败使用指数退避；到达重试上限后该 Webhook 进入自动停用状态，并在管理列表显示停用原因。轮换密钥会更新当前订阅及尚未领取的待投递事件密钥，不改变已完成或正在领取的事件；自动停用的 Webhook 仍保持停用，需删除并重新注册以恢复订阅。HTTP 只允许 HTTPS 和经过校验的公网 DNS 地址，拨号固定到已校验 IP、不跟随重定向；连接超时与响应字节均有上限。

Webhook 密钥仅创建或轮换时返回一次。数据库只保存用途隔离的 AES-256-GCM 密文；API 与 Scheduler 使用独立 `WEBHOOK_SECRET_ENCRYPTION_KEY` 根密钥，Worker 不接收该根密钥。
