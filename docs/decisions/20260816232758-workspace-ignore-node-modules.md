# ADR：Workspace Revision 排除 `node_modules` 依赖缓存

- 状态：已接受
- 日期：2026-08-16

## 背景

Agent 在 `/workspace` 内创建 TypeScript 项目并安装依赖时，包管理器会生成体积大、条目多且可由
锁文件重建的 `node_modules`。Workspace 的安全快照默认限制为 1024 个条目和 8 MiB；扫描整棵
依赖树会在源码与交付物已经生成后触发上限，导致模型已经给出结果，但 Run 在 Workspace 发布门
进入 `recovery_required`。

这类失败发生在 Workspace 快照捕获阶段、Sandbox 关闭之前，不是 Sandbox 暂停或挂起失败。当前
捕获失败发生在 operation journal 建立之前，并被发布边界收敛为依赖失败，因此公开错误只能显示
宽泛的 `WORKSPACE_CONFLICT`。

## 备选

1. 提高 Workspace 文件数和总字节上限。会把大量可重建依赖逐文件上传到对象存储，增加延迟、
   存储和恢复成本，并不能消除其他生态依赖缓存的膨胀。
2. 只在 Prompt 中要求模型把依赖装到 `/tmp`。依赖模型始终正确遵循目录约定，无法形成运行时
   不变量。
3. 在安全扫描边界排除名为 `node_modules` 的目录，继续保存源码、配置与锁文件。

## 决策

选择方案 3。CubeSandbox Workspace 的固定 dirfd 扫描在确认条目是普通目录且目录名为
`node_modules` 后，不记录也不递归进入该目录。任何同名文件、符号链接或特殊条目仍按原规则进入
扫描结果，并由 Workspace Publisher 的不安全条目校验失败关闭，不能借排除规则隐藏异常类型。

排除规则适用于任意层级的 `node_modules`。源码、`package.json`、锁文件以及模型显式发布的
Artifact 均不受影响。warm Sandbox 在复用期间可以继续保留现场依赖；从 Workspace Revision 冷
恢复时需要按锁文件重新安装。

## 影响

- 常规 Node.js 项目不会再因依赖缓存超过 Workspace 配额而在模型完成后失败。
- Workspace Revision 不再承诺持久化已安装依赖，离线恢复场景必须显式准备依赖缓存或使用交付物。
- 扫描不会打开或遍历被排除目录，现有 `openat2`、`O_NOFOLLOW` 和跨文件系统限制保持不变。

## 验证

- 适配器测试覆盖根目录与嵌套 `node_modules` 均不进入快照，而源码和锁文件继续被读取。
- 运行 Sandbox 包的格式、lint、typecheck 和定向测试。

## 可逆性

删除安全扫描的固定排除规则即可恢复完整目录快照；已经形成的 Revision 本身不包含依赖缓存，仍需
依据锁文件重建。
