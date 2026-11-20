# HTTP 工具参考

本文面向实现业务方 HTTP 工具接收端的开发者，以及维护 HTTP Transport 的 Hoox 贡献者，说明当前签名校验格式和 OpenAPI operation 导入边界。

## 请求签名

Hoox 使用工具版本凭据经 HKDF-SHA256 派生 HMAC 密钥，版本 ID 作为派生上下文，避免不同工具版本共用签名密钥。凭据缺失时请求在写出前失败。请求包含 `X-Hoox-Timestamp`（Unix 毫秒）、`X-Hoox-Signature`（小写十六进制 HMAC-SHA256）、`X-Hoox-Idempotency-Key`，以及 `X-Hoox-Tenant`、`X-Hoox-End-User`、`X-Hoox-Thread`、`X-Hoox-Run` 不透明标识。标识由同一版本密钥以 HMAC 派生，未配置终端用户时仍发送空值对应的派生标识。

待签名消息采用 UTF-8，字段以 LF 分隔：

```text
<timestamp>\n<METHOD>\n<path-and-query>\n<lowercase-hex-SHA256(request-body)>
```

POST 请求体为参数对象的 JSON 字节；GET 不带请求体。接收端应对时间戳施加自身的时效窗口，并按幂等键去重。仓库导出的 `verifyHttpToolSignature` 可用于校验签名；调用方须以相同工具版本凭据派生出的密钥调用。

## 当前实现范围

Router 通过受信执行端口提供 Tenant、终端用户、Thread、Run 内部标识；Transport 不从模型参数推导。HTTP 方法由工具版本解析端口提供，未配置时默认为 POST。Transport 固定使用已校验 DNS 地址、HTTPS、禁止重定向，并限制响应字节数。只接受 JSON 或 `text/*` 响应。HTTP 4xx（包括 408、429）产生受控失败；HTTP 5xx 和写出后的传输中断按结果未知进入恢复。当前 OpenAPI 导入器只接收一个 3.x operation 对象、HTTPS server、单一路径与 POST/GET 方法，以及受控 Schema 子集；GET 仅转换标量 query 参数。路径参数、引用、回调、安全定义、POST query 参数和非 JSON 请求体不予转换。GET 仅可用于只读工具。
