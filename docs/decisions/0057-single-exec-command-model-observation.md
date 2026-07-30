# ADR-0057：单一 exec_command 与模型可见真实执行结果

- 状态：已接受
- 日期：2026-07-30
- 决策者：Runtime 维护者
- 关联任务/PR：模型无感使用 CubeSandbox 的同步命令 MVP
- 替代关系：局部替代 ADR-0031 对 Sandbox 命令“原始结果不得进入模型”的约束；其 durable 配对、Blob 与恢复失败关闭约束继续有效

## 背景

当前模型同时看到 `sandbox_command`、`sandbox_run_code`、`sandbox_read_file` 和
`sandbox_write_file`，但所有工具在执行后只返回固定的“原始输出已隔离”回执。模型无法看到
`stdout`、`stderr` 和退出码，也就无法确认文件是否生成、定位依赖错误或根据非零退出码修正任务。
文件读取、写入和 Python 执行本来都可以通过 Sandbox 内的 Bash 完成，四个入口反而扩大了工具选择成本。

参考 Codex `exec_command` 后，首版目标明确为同步 MVP：先形成“执行—观察—修正”的最短闭环，
暂不引入 PTY、后台进程和交互式 stdin。宿主机命令能力仍由 Pi 的 `noTools=all` 禁用，命令只进入
当前 Run 已绑定的 CubeSandbox。

## 决策驱动因素

- 模型必须看到真实且有界的命令结果，才能自主完成文件生成任务；
- 非零退出码是命令业务结果，不是命令基础设施故障；
- 新工具不能绕过既有 `tool_call` 前驱、一次性许可和 `tool_result` durable 配对；
- 首版协议应尽量接近 Codex，同时明确记录暂未对齐的能力；
- 默认工作目录统一为 Sandbox 内 `/workspace`，不得暴露 Worker 宿主路径。

## 备选方案

### 方案 A：保留四个 Sandbox 工具，只放开各自输出

改动较小，但模型仍需在 Shell、Jupyter 和文件 API 之间选择，无法获得统一的退出码和输出语义；
以后每增加一种文件操作仍会继续增加工具。

### 方案 B：只暴露同步 exec_command，并返回真实有界结果

用一个 Bash 入口覆盖命令、Python 和文件操作。正常结果统一包含退出码、耗时、标准输出、标准错误、
截断标记和原始输出字节数；基础设施异常才产生 Tool Error。代价是模型可见上下文会包含低信任
Sandbox 输出，且首版尚无 Codex 的交互式会话能力。

### 方案 C：让 Pi 使用宿主机内建 Bash

接口最接近 Codex，但会绕过 `tool-router` 和 CubeSandbox 边界，使命令直接触碰 Worker 宿主机，违反
仓库的执行隔离约束。

## 选择

采用方案 B。新 Pi Session 的 Sandbox 工具白名单只有 `exec_command`。模型参数为：

- 必填 `cmd`；
- 可选 `workdir`，默认 `/workspace`；
- 可选 `timeout_ms`，默认 `120000`；
- 可选 `max_output_tokens`，默认 `10000`，首版策略上限为 `20000`。

工具在可信许可消费后立即调用 CubeSandbox，并在指定目录通过固定 `/bin/bash -c` 同步执行。正常返回：

```json
{
  "exit_code": 0,
  "wall_time_seconds": 1.274,
  "stdout": "generated\n",
  "stderr": "",
  "output_truncated": false,
  "original_output_bytes": 10
}
```

任意整数退出码都作为正常 Tool result 返回。CubeSandbox 超时、取消、协议或上游不可用才抛出稳定
`EXEC_*` Tool Error。上游私有错误正文不回显。

真实有界结果直接进入当前 Pi Session 的下一轮 Provider 请求。现有固定回执只用于 Trace Blob 与
Rollout 的 durable `tool_call + tool_result` 配对，不再作为本次命令的模型可见结果。若回执持久化未收敛，
仍在下一次 Provider 请求前失败关闭。

## 理由

方案 B 直接补齐模型完成任务所缺少的反馈闭环，同时不扩大到宿主执行。文件和 Python 并不需要独立
模型协议；Bash 已经能够组合这些能力。保留 durable 配对可以继续证明副作用调用的先后关系，且不需要
在本次协议切换中迁移 Rollout 数据。

方案 A 只修复“看不见”，没有修复工具设计重复。方案 C 虽然实现简单，但破坏已有 Sandbox 与
Run fence 不变量。

## 影响

### 正面影响

- 模型能根据真实 stdout、stderr 和退出码继续修正任务；
- 新 Run 不再暴露四个重叠的 Sandbox 工具；
- Shell、Python、文件读写共享一套超时、耗时与截断语义；
- Provider 工具循环测试能够直接证明下一轮收到了真实结构化结果。

### 负面影响与成本

- Sandbox 输出可能包含提示注入或敏感文本；它会进入模型上下文，开启模型网络报文诊断时也会按
  ADR-0055 的敏感 Trace 规则保存；
- 当前 Session 重建时只能从 durable 固定回执恢复“调用完成”，不能恢复本次真实 stdout/stderr；
- `max_output_tokens` 暂按 UTF-8 字节近似，不是模型 tokenizer 的精确 token 数。

### 安全、数据与运维影响

- 命令仍只调用当前 Run 的 `SandboxHandle`，不开放 Pi 宿主 Bash；
- 真实命令结果不写入当前 Tool Observation Trace Blob 或 Rollout，避免无迁移地改变既有持久协议；
- 非零退出码不会触发恢复或基础设施告警；`EXEC_UNAVAILABLE`、`EXEC_TIMEOUT` 等稳定错误才表示执行设施失败；
- 固定回执文本不再宣称“原始输出已隔离”，避免恢复投影与正常实时行为相矛盾。

## 验证

- Pi adapter 行为测试覆盖默认参数、Bash/workdir 引号、真实 stdout/stderr、非零退出码、UTF-8 头尾截断、
  超时与上游错误、许可拒绝和 durable 失败关闭；
- Pi Session 测试断言能力清单只包含 `exec_command`；
- Agent Worker 的真实 OpenAI-compatible transport 集成测试断言第二轮 Provider request 中的 Tool message
  包含真实 `exit_code` 和 `stdout`；
- 全仓执行 `pnpm check`。

## 可逆性与回退

公开工具协议没有数据库迁移。发布前可以整体回退到旧四工具；发布后回退会使仍按 `exec_command` 生成
调用的模型请求失败，因此应以新 Run 为切换边界，不能在同一活跃 Session 中热切换。既有 Rollout 固定
回执仍兼容，无需数据回写。

## 后续工作

- TODO(codex-alignment)：加入 PTY、`yield_time_ms`、后台 `session_id` 和 `write_stdin`，支持长任务与交互程序；
- TODO(codex-alignment)：CubeSandbox SDK 支持后改用独立 cwd 参数，移除 Bash `cd` 包装；
- TODO(codex-alignment)：使用当前模型 tokenizer 计算输出预算，并对齐 Codex 的截断策略与策略上限；
- TODO(codex-alignment)：保留超时前的部分输出，并将真实结果纳入可恢复终端 transcript；
- TODO(codex-alignment)：评估是否开放 Codex 的 `shell`、`login` 与 TTY 参数；首版固定 Bash 且不提供登录 Shell。

## 实施记录

- `pi-adapter` 已实现同步 `exec_command`、真实模型结果和稳定基础设施错误；
- `context-policy` 与 `run-contracts` 已移除“原始输出已隔离”的固定回执声明；
- Pi 与 Agent Worker 测试已切换到单工具协议。
