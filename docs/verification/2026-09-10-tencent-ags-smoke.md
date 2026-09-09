# 腾讯云 AGS 上海实测

本文记录 2026-09-10 北京时间的接入验证，供维护者区分已验证能力与上线前缺口。当前契约见 [Sandbox Provider](../architecture/sandbox-providers.md#腾讯云-ags)。

## 环境

- 代码分支：`codex/tencent-ags-provider`，适配实现基线 `1b3ae9b`；同分支扩充真实冒烟的代码执行和销毁确认。
- 调用端：本地 Windows，Node.js 与仓库固定 E2B SDK `2.39.0`；没有从 Oracle 春川服务器发起请求。
- 腾讯云上海地域，控制台创建默认代码解释器工具，公网网络策略，没有额外授予 CAM 角色。凭据只使用本机 `.env`，没有进入仓库或验证输出。
- 控制台可选广州、上海、北京、中国香港、新加坡和弗吉尼亚，没有韩国；上海是初始测试地域。春川到上海、香港的实际延迟尚未比较，因此不据此宣称上海性能最优。

## 实测结果

| 检查 | 结果 |
| --- | --- |
| Hoox AGS 网关真实冒烟 | create、command、Python、JavaScript、files、inspect、pause、connect、kill 全部通过 |
| 暂停恢复 | 暂停后 inspect 为 paused；connect 后 running，暂停前写入的文件仍可读，命令可执行 |
| 销毁 | finally 清理实例；销毁后网关返回 not_found，SDK 查询返回 SandboxNotFoundError |
| Worker 真实预检 | `TencentAgsSandboxSessionRegistry.probeExecution()` 通过管理面查询、30 秒实例创建、真实 Workspace 初始化、执行命令及 finally 清理 |
| 默认模板依赖 | 普通用户 uid 1000；Python 3、Node.js、sudo 可用，`sudo -n true` 成功 |
| TTL | API 创建 30 秒实例成功，getInfo 的 endAt 与 startedAt 相差 30 秒；控制台创建工具的 300 秒下限不代表 API 同样拒绝短 TTL |
| 运行中连接 | 对 30 秒实例 connect 指定 60 秒，endAt 延后 31 秒，证明此次运行中连接会延长实际 TTL |
| 创建请求 metadata | `agentRuntimeCreateRequestId` 原样保留；使用该值过滤列表只返回本实例，随机不匹配值返回空列表 |

真实冒烟可用 `pnpm test:tencent-ags:real` 重复执行。Worker 预检通过直接调用生产 Registry 的 `probeExecution()` 验证；TTL 与 metadata 检查使用同版本 E2B SDK 调用 create/getInfo/list/connect/kill，不模拟云端响应。

测试实例均显式销毁；保留可复用的测试工具定义。本机只补充 AGS 域名和模板配置，没有切换部署默认 Provider。

## 未覆盖范围

- 春川服务器网络延迟、生产部署切换和实际模型 Run。
- 真实附件、历史、技能 ResourceFS 快照、Workspace Revision 持久化以及文档交付完整链路。
- TTL 自然到期、长任务跨 TTL、Worker 重启、Scheduler 回收、暂停配额和恢复失败。
- 网络故障注入后的创建响应丢失对账；本次仅验证该机制依赖的 metadata 保存与过滤。

这些证据仅属于上述环境和时点；不能替代生产 Gate、跨地域验证或后续版本回归。
