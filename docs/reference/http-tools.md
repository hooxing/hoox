# HTTP 工具参考

本文面向实现业务方 HTTP 工具接收端的开发者，以及维护 HTTP Transport 的 Hoox 贡献者，说明当前签名校验格式、接收端必须执行的检查和 OpenAPI operation 导入边界。

## 请求头与签名

Hoox 使用工具版本凭据经 HKDF-SHA256 派生 HMAC 签名密钥（`deriveHttpToolSigningKey(credential, toolVersionId)`：盐为 `hoox-http-signature:<toolVersionId>`，info 为 `hmac-sha256-v1`，输出 32 字节），不同工具版本不共用签名密钥。凭据缺失时请求在写出前失败。每个请求携带：

| 请求头 | 内容 |
| --- | --- |
| `X-Hoox-Signature` | `v1=` 加小写十六进制 HMAC-SHA256 |
| `X-Hoox-Timestamp` | Unix 毫秒，13 位十进制 |
| `X-Hoox-Idempotency-Key` | 本次工具调用的幂等键；显式对账后的重试复用原值 |
| `X-Hoox-Tenant`、`X-Hoox-End-User`、`X-Hoox-Thread`、`X-Hoox-Run` | 64 位小写十六进制不透明标识 |

`v1` 待签名消息采用 UTF-8，以下各行以 LF 连接，末尾无换行：

```text
hoox-http-signature-v1
<X-Hoox-Timestamp>
<METHOD>
<path-and-query，与请求行完全一致>
<lowercase-hex-SHA256(request-body)>
<X-Hoox-Idempotency-Key>
<X-Hoox-Tenant>
<X-Hoox-End-User>
<X-Hoox-Thread>
<X-Hoox-Run>
```

POST 请求体为参数对象的 JSON 字节；GET 不带请求体，参数按名称排序追加到端点的固定查询之后。签名覆盖接收端用于去重和鉴权的全部头，改写任一头都会使验签失败。

不透明标识由仅 Hoox 持有的身份根密钥按工具版本派生的独立密钥计算，与签名密钥无关：接收端无法用已知内部 ID 反查或验证标识，不同工具版本的同一身份得到不同标识。同一工具版本内标识稳定，可用于业务方鉴权映射与审计。未配置终端用户时仍发送“无终端用户”对应的固定标识。

## 接收端必须执行的检查

1. 以原始请求行的路径与查询、原始正文字节和请求头验签，并拒绝与接收端当前时间相差超过 5 分钟的时间戳；同名签名相关头重复出现时按无效处理。`@hoox/tool-router` 导出的 `verifyHttpToolSignature` 是参考实现（时间窗口可由 `maxSkewMs` 调整），其他语言按上文格式实现即可。
2. 验签通过后、执行业务副作用前，按 `X-Hoox-Idempotency-Key` 原子去重：用唯一约束或原子写入抢占该键，已存在时不得再次执行，应返回首次执行的结果。去重记录的保留时间不得短于时间窗口。

```ts
if (!verifyHttpToolSignature({ key: signingKey, method: req.method, path: req.url, body, headers: req.headers }))
  return reply(401);
// 以 PostgreSQL 为例：唯一约束保证并发请求中只有一个能抢占幂等键。
const key = req.headers["x-hoox-idempotency-key"];
const claimed = await db.query(
  "INSERT INTO hoox_tool_calls (idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING 1",
  [key],
);
if (claimed.rowCount === 0) return replyWithStoredResult(key);
```

## 响应与失败语义

- 2xx 且正文为 JSON 或 `text/*`：成功；204、205 或声明 `Content-Length: 0` 的 2xx 为合法空成功。
- 3xx 与 4xx（包括 408、429）：受控失败，不进入恢复；Transport 不跟随重定向，不读取错误正文并立即关闭连接。
- 5xx、无法解释的 2xx 正文、正文超过字节上限、正文中途断开、写出后超时或取消：结果未知，按[外部工具结果未知](../architecture/run-execution-and-recovery.md#外部工具结果未知)进入恢复，不自动重放。

持凭据端点的成功响应不向模型公开正文；检测到凭据回显时，固定提示明确调用已成功、请勿重试。无凭据端点可以返回有界业务正文，本次签名和时间戳不会原样投影。详见[模型可见结果](../architecture/tool-calling-modes.md#模型可见结果)。

## 当前实现范围

Router 通过受信执行端口提供 Tenant、终端用户、Thread、Run 内部标识；Transport 不从模型参数推导。HTTP 方法只来自不可变版本快照，不默认 POST；GET 仅可用于只读工具，且模型参数不得与端点固定查询键重名。整次调用从 DNS 预检起共享一个截止时间。Transport 每次调用新建连接、直接拨号到已校验 IP，证书与 SNI 按原主机名校验并保留原 `Host`。缺少方法的 HTTP 版本不能装配；Transport 也会在缺少方法时按 `not_sent` 拒绝发包。调用上下文只包含可信 Tenant、Thread、Run 内部事实；当前尚无可信终端用户映射，因此发送“无终端用户”固定标识，不以所有者或 Thread 创建者代替。`EXTERNAL_TOOL_IDENTITY_ROOT_KEY` 是部署级秘密，生产必填，用于派生不透明身份标识。

OpenAPI 导入器只接收一个 3.x operation 对象、HTTPS server、POST/GET 方法和受控 Schema 子集。server 独立校验后再拼接路径，路径仅允许由字母、数字和 `-._~` 组成的非点段，解析后必须保持 server 的 origin。各层对象只接受白名单字段，任何 `$ref`（包括与内联字段混用）都会被拒绝；`responses` 不参与转换。GET 仅转换标量 query 参数，参数名不得与 server 中的固定查询键重名。路径参数、回调、安全定义、POST query 参数和非 JSON 请求体不予转换。
