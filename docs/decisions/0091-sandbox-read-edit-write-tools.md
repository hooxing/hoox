# ADR-0091：为 Agent 增加受控 read、edit、write 文件工具

- 状态：已接受
- 日期：2026-08-03
- 决策者：Runtime 维护者
- 关联任务/PR：补齐 Pi 风格文件工具与模型工具选择准则
- 替代关系：局部替代 ADR-0057“文件读写不需要独立模型协议”和 ADR-0058“新 Run 只暴露 `exec_command` 与 `deliver_file`”的工具清单结论；`exec_command`、`deliver_file` 的 Sandbox、许可、输出截断和 durable 配对约束继续有效

## 背景

Runtime 当前只向模型暴露 `exec_command`。它能够通过 Bash 完成文件读取和修改，但模型必须自行组合
`cat`、`sed`、重定向或脚本，难以稳定表达分页读取、唯一文本替换以及多个不相邻修改都基于同一原文件
匹配等语义。Pi 已提供 `read`、`edit`、`write` 的成熟工具协议和使用准则，适合作为模型接口参考；其默认
实现直接访问宿主文件系统，不能在本 Runtime 中启用。

文件工具仍必须只操作当前 Run 绑定的 CubeSandbox，继续经过 `tool.started` 前驱、一次性执行许可和 durable
`tool_call + tool_result` 配对。图片读取还会产生 Base64 工具结果，不能复制进长期 Thread Context。

## 决策驱动因素

- 为模型提供与意图一致的读取、精确修改和完整写入协议；
- 保持 Pi 工具名称、参数字段、描述和主要错误语义，降低模型切换成本；
- 禁止 Pi 内建工具触碰 Agent Worker 宿主目录；
- `edit` 的全部 `oldText` 必须针对同一原文件、唯一且互不重叠；
- 文本读取必须有 2000 行和 50KB 双上限，并可用 `offset`/`limit` 继续；
- 图片只进入当前模型工具循环，长期历史只保留文本说明；
- System Prompt 的工具选择准则必须固定且可版本审计，不能注入请求级数据。

## 备选方案

### 方案 A：继续只使用 exec_command

无需增加协议，但模型需要重复生成易错的 Shell 文本处理命令，无法由 Runtime 原子校验多处替换是否都匹配
原文件，也不能直接返回图片附件。

### 方案 B：启用 Pi 内建 read、edit、write

协议完全复用 Pi，实现改动最小；但默认实现使用 Node 文件系统和宿主 cwd，会绕过 CubeSandbox 与
Runtime 执行许可，违反仓库边界。

### 方案 C：保留 Pi 协议，在 pi-adapter 中实现 CubeSandbox 版本

模型看到 `read`、`edit`、`write`，实际 I/O 只调用当前 `SandboxHandle`。实现需要自行处理路径、图片、
精确替换、父目录和结果投影，但能维持现有安全边界。

## 选择

采用方案 C，并保留 `exec_command`：

1. Sandbox 工具固定为 `exec_command`、`read`、`edit`、`write`，可选交付工具仍按 ADR-0058 注册；Pi
   以 `noTools=all` 禁用全部默认工具，同名文件工具只注册 Runtime 自定义实现，宿主 Bash、grep、find
   和 ls 不开放。
2. 相对文件路径以 Sandbox `/workspace` 解析，绝对路径仍表示 Sandbox Linux 路径；不得解析为 Worker
   宿主路径。
3. 每个工具都使用 schema-invalid bridge。Schema 错误形成失败回执，但不申请许可、不触碰 Sandbox。
4. `read` 先在 Sandbox 内读取小段二进制签名。文本通过 Sandbox 文件端口读取，按 2000 行或 50KB
   先到者截断；图片读取完整字节并以内联附件返回，单张上限 32MB。
5. `edit` 在同一原文件上定位全部 `oldText`，拒绝空文本、未匹配、不唯一、重叠和无变化替换；按位置
   逆序应用。匹配时隐藏 UTF-8 BOM、统一换行，写回时恢复原换行和 BOM。相同 Sandbox、相同路径的
   修改在内存队列中串行化，队列不得调用宿主文件系统。
6. `write` 先在 Sandbox 内创建父目录，再通过文件端口完整覆盖内容；与 `edit` 共享同路径串行边界。
7. 图片附件只用于当前 Pi 工具循环。`turn.completed` 投影丢弃图片 Base64，只保留同一工具结果中的
   `Read image file [...]` 文本，避免扩大 Thread Context 和 durable Rollout。
8. `PLATFORM_HARNESS` 增加工具选择准则：枚举与搜索使用 `exec_command`，正文读取使用 `read`，精确
   修改使用 `edit`，新建或完整重写使用 `write`。Prompt 版本升级为 `runtime-system-prompt.v3`。
9. `exec_command` 已有基于模型预算的 UTF-8 输出截断、截断标记和原始字节数，本次不重复引入另一套
   Bash 截断协议。

## 理由

方案 C 把 Pi 已验证的模型协议与 Runtime 的隔离执行边界组合起来。独立文件工具减少 Shell 转义和脚本
生成错误，Runtime 也能在写回前验证精确替换不变量。继续保留 `exec_command` 可覆盖目录搜索、复杂批处理
和文件工具无法表达的操作。

方案 B 会直接破坏最重要的宿主隔离约束。方案 A 虽然入口更少，但把确定性的文件语义重新交给模型生成
Shell，实际可靠性和上下文成本更差。

## 影响

### 正面影响

- 模型可分页读取大文本，并直接查看 Sandbox 图片；
- 多处精确修改要么整体通过校验并写回，要么不写文件；
- 新文件和完整重写不再依赖 Shell heredoc 或复杂引号；
- capability manifest、诊断和 Provider 工具定义自动包含四个受控工具。

### 负面影响与成本

- 工具 schema 和固定 Harness 增大基础上下文，并使 Provider 为 v3 建立一次新缓存；
- 图片读取当前需要 Sandbox 命令生成 Base64，读取大图会增加 Sandbox 与 Worker 的瞬时内存；
- 当前可恢复历史不保存图片字节，Session 重建只能恢复图片读取的文本说明；
- 文件真实输出仍只进入当前 Pi Session，durable Observation 继续保存固定成功/失败回执。

### 安全、数据与运维影响

- Pi 默认宿主文件工具继续关闭；所有文件 I/O 都绑定当前 `SandboxHandle`；
- 工具许可拒绝、过期、取消和 durable 结果未收敛均沿用失败关闭语义；
- 上游私有错误正文不返回模型；模型只看到稳定 `READ_*`、`EDIT_*`、`WRITE_*` 错误；
- 图片 Base64 不进入 Thread Context、固定 system prompt 或 Tool Observation Blob。

## 验证

- 单元测试覆盖工具 schema bridge、相对路径、分页与行截断、图片附件、多个原文件替换、不唯一、重叠、
  未匹配、父目录创建、UTF-8 字节数、许可拒绝和 durable 回执；
- Pi 事件测试证明图片 Base64 不进入 Thread Context；
- Pi Session 测试证明四个自定义工具与 capability manifest 一致，宿主内建工具仍不开放；
- Prompt Builder Golden 测试固定 v3 Harness、摘要和文件工具准则；
- 执行受影响包的格式、lint、typecheck 和测试。

## 可逆性与回退

本变更没有数据库迁移。可按新 Run 边界移除三个文件工具、恢复 v2 Prompt，并把同名工具重新加入
`excludeTools`。活跃 Session 的 capability manifest 不得热切换；已经记录的固定工具回执和 Thread 文本
仍符合现有通用协议，无需数据回写。

## 后续工作

- 评估 CubeSandbox SDK 原生二进制读取，移除图片 Base64 Shell 探测；
- 评估在不复制图片字节的前提下，为恢复历史保存受控图片资源引用；
- 根据真实模型行为决定是否将 `exec_command` 的截断策略进一步对齐 Pi 的 2000 行/50KB 尾部策略。

## 实施记录

- 2026-08-03：完成三个 CubeSandbox 文件工具、v3 固定 Harness、图片历史投影和自动化测试。
