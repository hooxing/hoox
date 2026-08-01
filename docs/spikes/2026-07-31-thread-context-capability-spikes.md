# Thread 连续上下文阶段 0 能力 Spike 记录

- 状态：部分完成，不能据此通过阶段 0 Gate
- 观测日期：2026-07-31（Asia/Shanghai）
- 代码基线：`8299fcf`
- Node.js：`v24.18.0`
- Cube 测试目标身份 SHA-256：`e6c6a99e14403bd1d970cd464c7b882823ee9c9e6ac8f40950814aac1599b2d2`
- 模型测试目标身份 SHA-256：`260bf852ca0036a177d359c1133c413b60e05f871507d999fe7ee9b9e65a09c1`

身份摘要只用于区分测试目标，由规范化 endpoint 与 template/model ID 计算；本文不记录 endpoint、credential、Sandbox ID、模型输出正文或用户数据。

## 1. CubeSandbox 实测

### 1.1 现有真实 smoke

使用仓库 `runtime-ts/packages/sandbox/src/real-smoke.ts`，显式加载本地测试配置并启用真实 smoke。以下链路通过，Sandbox 在 `finally` 中确认清理：

```text
create(TTL=120)
→ command
→ Python in-memory value
→ file write/read
→ pause confirmed
→ connect auto-resume
→ in-memory value/file/command 再验证
→ terminate
```

本次端到端总耗时约 17.9 秒。该脚本包含构建/启动开销，不能把总耗时当成 pause/resume SLO。

### 1.2 pause/connect 延迟与即时快照恢复

同一测试目标连续执行三次，每次创建独立 Sandbox、写入 Python 内存变量与临时文件、等待 pause 确认、通过 connect 恢复、验证内存/文件，再确认 terminate。

| 重复 | create | pause confirmed | connect/auto-resume | 恢复证明 |
|---|---:|---:|---:|---|
| 1 | 94 ms | 1123 ms | 57 ms | 内存与文件一致 |
| 2 | 87 ms | 559 ms | 53 ms | 内存与文件一致 |
| 3 | 78 ms | 558 ms | 43 ms | 内存与文件一致 |
| 中位数 | 87 ms | 559 ms | 53 ms | 3/3 通过 |

这些数字只描述当前测试环境、当前时刻和即时恢复，不是产品默认超时、SLO 或 retention 保证。

### 1.3 TTL 候选与 lifecycle payload

通过 vendored SDK 直接提交带 `lifecycle.onTimeout="pause"`、`autoResume=true` 的 create，逐项创建后立即确认 terminate：

| TTL 候选 | create 接受 | terminate |
|---:|---|---|
| 120 秒 | 是 | confirmed |
| 121 秒 | 是 | confirmed |
| 300 秒 | 是 | confirmed |
| 600 秒 | 是 | confirmed |
| 3600 秒 | 是 | confirmed |
| 86400 秒 | 是 | confirmed |

结论只能写成：**当前测试部署观测到的可接受下界至少为 86400 秒**。这不能证明 86400 是 Provider 最大值，也不能证明快照会保留同样时长。当前数据库的 86400 上限和生产 Gateway 的 120 上限都是 Runtime 自身边界，不应被误写成 Provider 保证。

上游当前版本的发布说明已把 timeout 描述为三值语义，其中正整数表示对应秒数的 idle TTL，但本次未取得测试部署版本，不能把上游最新行为直接外推到本地部署。参考：[CubeSandbox Releases](https://github.com/TencentCloud/CubeSandbox/releases)。

### 1.4 `onTimeout=pause` 与 connect 自动恢复

创建 `TTL=2`、`onTimeout=pause`、`autoResume=true` 的独立 Sandbox：

- create 后约 5.5 秒观测到管理面状态为 `paused`；
- 随后 `connect` 在 179 ms 内成功并返回可用实例；
- 最终 terminate confirmed。

这证明当前测试部署接受并执行了本次短 TTL 的自动 pause，且 connect 能自动恢复。它仍不能替代 Runtime pause intent/receipt、Thread queue 线性化或 UNKNOWN 对账。

### 1.5 尚未完成

- 测试部署的明确平台/组件版本证据；
- Provider 的精确最大 TTL、是否支持运行时续期及续期上限；
- 分钟/小时/天级 paused dwell 后的快照保留与恢复；
- 快照大小、存储占用和配额；
- pause/connect/terminate 的网络超时、结果未知与状态查询收敛；
- 并发 pause/connect、pausing 时输入和后台进程漂移。

因此 ADR-0066 的 retention、TTL、操作超时、重试与 manifest 校验仍必须保持配置化或待决。

## 2. Provider `/chat/completions` 实测

对当前配置的模型目标分别使用 `stream=false` 和 `stream=true` 提交三类历史。每个请求限制极小输出；只记录 HTTP 状态和 SSE 完成标记，不记录响应正文。

| Case | 历史形状 | 非流式 | 流式 |
|---|---|---|---|
| `multi_turn` | 当前 system + user + assistant + 新 user | HTTP 200 | HTTP 200，`[DONE]` |
| `handoff_as_low_trust_user` | 当前 system + 低信任 handoff 候选 + 新真实 user | HTTP 200 | HTTP 200，`[DONE]` |
| `tool_pair_tail` | assistant tool call + 配对 tool result + 新 user，并携带当前 tool schema | HTTP 200 | HTTP 200，`[DONE]` |

可得结论：

- 当前目标接受服务端重建的普通多轮历史；
- 当前目标接受完整 tool call/result 历史与后续 user；
- 把 handoff 候选投影为低信任 user 消息在传输层可接受；
- 流式与非流式均能完整结束。

不能由此得出的结论：

- 传输成功不代表 handoff 的最终 role 已获得架构批准；
- 不能把 `compaction_handoff` 存成真实 `user_message`，也不能提升为可信 system/developer；
- 尚未验证 reasoning、图片、音频、Provider 特殊 compaction item、模型切换和远程 compaction；
- 尚未完成 adapter 规范化后“在线 history digest = 重启恢复 digest”的实现级验证。

因此 ADR-0065 保持事实 kind 与 wire role 分离；阶段 0 仍需审阅最终 adapter capability matrix。

## 3. 对阶段 0 Gate 的影响

| Gate | 当前状态 |
|---|---|
| 真实 pause/resume 能力有证据 | 部分通过：即时 pause/connect、状态恢复和短 TTL auto-pause 已证明 |
| TTL/retention 能力已明确 | 未通过：只证明 TTL 接受到 86400，未证明最大值或长 paused retention |
| `/chat/completions` replacement history 形状明确 | 部分通过：基础多轮/tool/低信任 handoff 候选可传输；最终语义映射与特殊 item 未决 |
| UNKNOWN/崩溃测试基座 | 未通过：共享测试基座尚未实现 |
| 可以改变生产读取语义 | 否 |

本记录是单次环境观测。后续每次 Provider/Cube 版本、模型 compatibility identity、tool schema 或 lifecycle 配置变化，都必须产生新的证据记录或自动 capability test，不能覆盖本记录。
