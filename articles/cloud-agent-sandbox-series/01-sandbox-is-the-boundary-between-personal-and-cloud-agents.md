---
title: 从领域 Agent 到云端 Agent，Sandbox 真正难的不是隔离
series: 从 OpenClaw 到 Manus：为 Agent 造一台云电脑
status: draft
date: 2026-08-25
---

# 从领域 Agent 到云端 Agent，Sandbox 真正难的不是隔离

做一个政务公文 Agent 或律师助手，看起来并不难。

找一个现成的 Agent Runtime，换一套 System Prompt，挂上公文写作、法律检索或案卷分析 Skill，再准备几个工具，一个领域 Agent 的 Demo 很快就能跑起来。

如果只是开发者自己在一台电脑上使用，这个判断基本没有问题。

但真实产品很快会提出另一组要求：用户希望在手机上提交任务，合上电脑后让任务继续运行；第二天在办公电脑上查看结果；同事能够接着处理同一个事项；一次案卷分析可以运行十几分钟甚至更久；过程需要可追溯，文件和执行环境不能依赖某一台个人设备是否开机、依赖是否安装完整、浏览器是否还保持登录。

到了这里，问题已经不只是怎样修改 Prompt、增加 Skill，而是谁来为 Agent 提供那台能够持续工作的电脑。

最近我探索了一下 Manus 之类的云端 Agent 是如何实现的，也顺手用 Codex 实现了一个叫 [Hoox](https://github.com/hooxing/hoox) 的 Agent Runtime。实现过程中，我对个人 Agent 和云端 Agent 的分界有了一个更具体的认识：

> 从个人 Agent 走向多人并发使用的云端 Agent，最容易被低估的不是模型循环，而是 Sandbox 的所有权与失败契约。

这里说的 Sandbox，不只是“为了安全，把 Shell 放进容器里执行”。当平台替用户提供执行环境后，Sandbox 就成了 Agent 的云电脑。平台不但要创建它，还必须解释它属于谁、谁现在有权使用、创建超时后到底有没有成功、Worker 崩溃后里面的进程怎么办、机器被回收后用户的工作是否还存在。

这些问题，才是从个人助手走向云端 Agent 时真正容易踩坑的地方。

先说明标题里的“真正难的不是隔离”：这并不是说强隔离已经毫无难度，更不是说选一个容器镜像就万事大吉。只是到了今天，Firecracker、gVisor 以及成熟云厂商提供的隔离计算服务，已经让团队不必从零实现 Hypervisor 或系统调用隔离。它们回答的是“不同任务能不能互相越界”，却不会替 Runtime 回答“这台机器属于谁、谁现在有权使用、超时后该不该重试、机器消失后状态从哪里恢复”。

隔离是底座，隔离之上的所有权、生命周期和失败契约，才是业务逻辑最容易翻车的部分。

## 先看一个典型失败路径

假设一名律师在手机上提交任务：

> 分析这批案卷材料，检索相关法规，整理争议焦点，并生成一份代理意见初稿。

平台收到任务后，请求 Sandbox Provider 创建一台隔离的云电脑。Provider 已经创建成功，但响应在返回途中超时了。

```text
控制面请求创建 Sandbox
        ↓
Provider 创建成功
        ↓
响应返回前网络中断
        ↓
控制面只看到了 timeout
```

如果按照普通 API 调用的思路处理，最自然的动作是重试。

结果可能是：第二台 Sandbox 也被创建出来了。数据库只记录了第二台，第一台却仍然在 Provider 侧运行和计费；更糟糕的是，第一台里的进程可能已经开始读取案卷、写入文件或访问外部服务。

随后 Worker 再次重启，新 Worker 只知道数据库里的第二台机器。用户最终看到的报告可能来自第二个执行环境，而第一个环境仍然在后台生成另一份结果。

这不是更换模型、加强 Prompt 或增加一次重试能够解决的问题。

它暴露的是一个控制面事实：

> **超时不等于失败。对于会创建外部资源的操作，超时往往意味着结果未知。**

在个人 Agent 中，这类问题不明显，因为那台电脑通常已经存在，而且属于用户。云端平台则必须对每一次创建、接管、暂停和销毁负责。

## 个人 Agent 已经天然拥有执行环境

以 OpenClaw 这一类个人 Agent 为参照，它面对的典型场景是：用户先准备好自己的电脑或服务器，再让 Agent 使用这台机器上的文件、浏览器、登录状态和开发环境。

很多问题已经被“用户拥有这台机器”这个前提解决了：

- 文件默认落在用户自己的磁盘；
- 依赖安装在用户自己的环境；
- 浏览器登录状态属于机器的主人；
- 机器什么时候关闭由用户决定；
- 运行成本和环境维护主要由用户承担。

OpenClaw 也可以部署到服务器，并支持不同形式的 Sandbox。这里并不是说个人 Agent 不能运行在云上，更不是说这种架构不够先进。真正的区别不是进程位于本地还是某个机房，而是：

> **执行环境由用户负责，还是由平台负责。**

当平台负责时，它同时接过了机器身份、数据归属、持续运行、故障恢复、多租户隔离和资源成本。这时 Sandbox 不再是安全附加功能，而是产品能够成立的基础设施。

## 三个看似合理、实际很危险的简化

很多 Sandbox Runtime 的第一版都有类似接口：

```ts
interface SandboxProvider {
  create(): Promise<Sandbox>;
  exec(id: string, command: string): Promise<ExecResult>;
  destroy(id: string): Promise<void>;
}
```

作为 Demo，这已经够了。但如果把这三个方法直接当成云端 Agent 的运行时契约，会隐含三个危险假设。

### 假设一：拿到 Sandbox ID，就有权操作它

Sandbox ID 只是远端资源身份，不是执行授权。

假设 Worker A 获得一台 Sandbox，开始执行任务。随后它的租约过期，Worker B 接管了同一个 Run。此时 Worker A 因网络恢复又继续运行，如果系统只检查 Sandbox ID，它仍然可以向那台机器写文件、启动进程和发布结果。

可能出现的后果包括：

- 旧 Attempt 覆盖新 Attempt 刚写入的 Workspace；
- 用户插话要求停止修改，但旧 Worker 仍在继续；
- 已经取消的任务再次产生外部副作用；
- 新旧 Worker 各自发布一份“最终结果”。

因此，执行权至少需要同时绑定：

```text
Tenant
+ Thread
+ Sandbox Session
+ generation
+ ExecutionAttempt
+ lease
+ capability
```

Sandbox 可以继续存在，但旧 Attempt 的 capability 必须失效。

这里已经不是容器访问问题，而是分布式所有权问题。

> **Show me the code：执行权如何收回**
>
> Hoox 的 [`RunWorker.execute`](https://github.com/hooxing/hoox/blob/main/runtime-ts/apps/agent-worker/src/run-worker.ts) 先从 PostgreSQL 领取带期限的执行 fence；[`PgExecutionPersistence`](https://github.com/hooxing/hoox/blob/main/runtime-ts/packages/persistence/src/pg-run-worker-state.ts) 使用 claim token、epoch 和 Workspace lease 做持久化校验；真正访问 `/workspace` 时，[`SandboxWorkspacePort`](https://github.com/hooxing/hoox/blob/main/runtime-ts/packages/sandbox/src/workspace-adapter.ts) 还会通过 `TrustedSandboxSessionCapability` 重新验证 session 与 generation。旧 Worker 即使仍然持有 Sandbox ID，也无法把这个 ID 继续当作执行权限。

### 假设二：Provider 显示 running，Sandbox 就可以使用

Provider 控制面返回 `running`，只能证明它认为资源仍然存在，不代表数据面已经准备好。

可能出现：

- Exec 接口暂时不可用；
- 文件服务尚未启动；
- 网络代理没有就绪；
- ResourceFS 没有挂载成功；
- 持久卷连接失败；
- 上一个后台进程仍然占满 CPU 或磁盘。

因此必须区分：

```text
Provider Control Plane Running
              ≠
Sandbox Data Plane Ready
              ≠
Current Attempt Authorized
```

同样，命令返回超时也不代表进程已经停止。一个超时的 Python、FFmpeg 或依赖安装进程，可能仍然在 Sandbox 内继续写文件。如果 Runtime 直接重试，就可能同时运行两个相同任务。

普通的容器封装关心“命令有没有返回”，云端 Agent Runtime 还必须关心“进程是否仍然存在，以及谁有权决定它的后续命运”。

> **Show me the code：未知结果如何收敛**
>
> [`coordinateWaitingRecovery`](https://github.com/hooxing/hoox/blob/main/runtime-ts/apps/agent-worker/src/waiting-recovery.ts) 要求 connect、create、materialize 等外部副作用先写入独立 intent，返回 `unknown` 时不会盲目自动重放；[`ThreadSandboxLifecycleConsumer`](https://github.com/hooxing/hoox/blob/main/runtime-ts/apps/scheduler/src/thread-sandbox-lifecycle-consumer.ts) 则负责 pause、terminate 等生命周期操作的执行与远端状态对账。

### 假设三：`/workspace` 就是用户工作的事实源

把所有文件放进 Sandbox 的 `/workspace`，开发起来最直接。但 Sandbox 最终一定会暂停、替换或销毁。

如果 `/workspace` 是唯一事实源，那么机器被 Provider 回收后，用户上传的文件、Agent 修改的代码和生成的报告都会一起消失。系统不仅无法恢复文件，也无法证明用户最后看到的是哪一个版本。

永久保留整块磁盘也不是免费的答案：

- `node_modules` 和浏览器缓存是否需要永久保存；
- 临时日志和下载文件是否属于用户工作；
- 磁盘能否迁移到另一家 Provider；
- 多次写入失败时哪个版本可信；
- Sandbox 里的文件是否已经完成上传和授权。

更稳妥的模型是把计算和业务状态分开：

- **Resource**：用户上传或从资源库引用的不可变输入；
- **Workspace**：Thread 私有、可变、可版本化的工作目录；
- **Artifact**：Agent 明确发布给用户的最终交付物。

此时 Sandbox 中的 `/workspace` 只是某个 Workspace Revision 的一次物化：

```text
持久化 Workspace Revision
          ↓ materialize
临时 Sandbox /workspace
          ↓ Agent 修改
候选 Workspace Revision
          ↓ commit
新的持久化 Workspace Revision
```

Sandbox 可以被销毁，只要平台仍然保存最新 Revision 和必要 Resource，就能在另一台机器中重新构造工作环境。

而 Agent 在 `/workspace` 中生成了 `report.docx`，也不代表用户已经拿到了它。文件还需要离开临时 Sandbox，进入持久存储，绑定正确的租户、Thread 和版本，并获得下载授权。

> **文件存在是计算事实，文件交付是产品事实。**

> **Show me the code：Sandbox 如何与持久 Workspace 解耦**
>
> [`WorkspaceMaterializer`](https://github.com/hooxing/hoox/blob/main/runtime-ts/packages/workspace/src/materializer.ts) 根据目标 Manifest 把稳定对象物化到 `/workspace`；Worker 侧的 [`ManifestWorkspaceRuntime`](https://github.com/hooxing/hoox/blob/main/runtime-ts/apps/agent-worker/src/workspace-runtime.ts) 负责加载当前 Revision、打开受限 Sandbox Workspace，并把修改发布成候选 Revision；[`ArtifactCompletionGateAdapter`](https://github.com/hooxing/hoox/blob/main/runtime-ts/packages/artifact/src/completion-gate.ts) 则把 Artifact 发布结果纳入任务完成条件。

## 一台 Sandbox 到底应该属于谁

“给 Agent 一台云电脑”还有一个必须明确的选择：它应该以什么粒度分配。

| 分配方式 | 连续性 | 隔离 | 成本 | 最主要的风险 |
| --- | --- | --- | --- | --- |
| 每个用户永久一台 | 最强 | 用户间清晰，任务间较弱 | 最高 | 长期污染、闲置成本、秘密残留 |
| 每个 Thread 一台 | 适合连续工作 | Thread 间隔离 | 中等 | 旧进程和环境污染后续 Run |
| 每个 Run 一台 | 一般 | 较强 | 较高 | 依赖反复安装、上下文连续性差 |
| 每个 Attempt 一台 | 最弱 | 最强 | 很高 | 重试产生孤儿资源，恢复成本高 |

不存在对所有产品都正确的选择。

纯 per-Run 或 per-Attempt 的环境更干净，适合短任务和强隔离场景；Thread 级复用可以保留依赖和工作环境，更适合持续数天的代码、研究或文档任务，但 Runtime 必须额外处理旧进程、环境污染和执行权移交。

Hoox 当前采用的是一种折中：Sandbox 的连续性主要跟随 Thread，具体执行权属于当前 ExecutionAttempt。Run 完成后，Sandbox 可以 pause；下一次输入优先 resume。无法证明环境仍然安全可用时，则放弃复用并从持久 Workspace 重建。

这不是唯一正确答案，而是用更复杂的生命周期管理换取连续性和成本之间的平衡。对于更强调一次性隔离的业务，选择 per-Run Sandbox 可能反而更合适。

## Sandbox Runtime 真正需要持久化什么

如果 Sandbox 只是一个容器，记录远端 ID 似乎就够了。

如果它是一台由平台管理的 Agent 电脑，控制面至少需要理解：

- **所有权**：Tenant、Thread 和 Workspace；
- **远端身份**：Provider key、Sandbox ID 和 generation；
- **生命周期**：creating、running、paused、unknown、terminating、terminated；
- **执行权**：当前 Attempt、lease、过期时间和 capability；
- **数据基线**：Sandbox 对应哪个 Workspace Revision；
- **能力状态**：Exec、文件、网络、ResourceFS 等数据面是否可用；
- **待处理副作用**：需要继续创建、对账、暂停还是销毁；
- **失败语义**：确定失败、可安全重试，还是结果未知。

这些状态不能只存在于 Worker 内存里。否则 Worker 重启以后，新的执行者只能看到一台远端机器，却无法判断它为什么存在、属于谁、里面可能还有什么进程，以及自己是否有权继续使用。

## 三条不变量，以及违反它们会发生什么

实现这类 Runtime 时，我认为至少需要守住三条不变量。

### 一、Sandbox 可以消失，任务不能消失

常见错误是把模型 Session、工具循环和任务状态都保存在当前 Worker 内存中。

一旦 Worker 崩溃，平台只能重新开始整个任务。已经完成的工具调用可能被重复执行，用户也无法判断任务是失败、仍在运行，还是等待恢复。

因此 Run、Attempt、输入和关键工具事实必须独立于 Worker 持久化。

### 二、Sandbox 可以消失，用户的工作不能消失

常见错误是把 `/workspace` 当作唯一文件来源。

一旦 Provider 因 TTL、故障或调度回收机器，报告、代码和中间状态全部丢失。即使用户曾经在界面上看到“已完成”，平台也无法重新交付同一版本。

因此 Workspace 必须可以版本化和重新物化，Artifact 必须显式发布。

### 三、Sandbox 可以复用，但旧的执行权不能复用

常见错误是把 Sandbox ID 同时当作资源身份和调用权限。

当租约移交、Run 取消或 Attempt 过期后，旧 Worker 仍可能继续写文件、执行命令和发布结果，污染新的执行状态。

因此资源身份可以长期存在，执行 capability 必须跟随 Attempt 和 generation 收敛失效。

这三条不是为了让架构图更漂亮。它们分别防止三类最实际的问题：任务丢失、用户工作丢失，以及过期执行者继续产生副作用。

## 如果你正在实现云端 Agent，至少先回答这些问题

在选择具体 Sandbox Provider 或容器技术前，可以先检查自己的 Runtime 是否能回答下面的问题：

1. Sandbox 属于 User、Thread、Run，还是 Attempt？
2. 创建请求超时后，怎样判断远端是否已经创建成功？
3. Worker 崩溃后，怎样知道 Sandbox 中是否还有进程运行？
4. Provider 显示 `running` 时，怎样验证数据面真的可用？
5. 谁拥有当前执行权，执行权如何撤销？
6. Sandbox 被回收后，Workspace 从哪里恢复？
7. Sandbox 中的文件在什么时刻成为用户可下载的 Artifact？
8. 旧 Attempt 如何被禁止继续调用工具？
9. 远端状态和数据库状态不一致时，谁负责对账？
10. 为了降低成本复用 Sandbox 时，怎样处理旧进程、缓存、秘密和环境污染？

如果这些问题的答案仍然是“重试一下”“重新创建一个容器”或“文件应该还在磁盘里”，那么系统拥有的可能还只是一个 Sandbox SDK 封装，而不是可以承载多人并发的云端 Agent Runtime。

## 结语

领域 Agent 的能力表面上可以通过 Prompt、Skill 和工具快速扩展，但产品形态不会因此自动成立。

当用户要求多端访问、后台长时间运行、多人协作、环境可控和过程可追溯时，平台就必须替用户提供那台电脑。一旦执行环境由平台负责，Sandbox 的所有权、失败语义、数据持久化和执行权收回就会成为硬问题。

所以真正值得关注的不是“Agent 要不要运行在 Sandbox 里”——这已经是入门级共识，而是：

> **平台怎样管理一台随时可能创建失败、失联、被复用或被销毁的 Agent 电脑，同时保证任务、用户工作和执行边界仍然可信。**

下一篇准备继续讨论一个更具体的问题：一台 Sandbox 究竟应该属于 Thread、Run 还是 Attempt，以及不同选择如何影响连续性、隔离和成本。

## 延伸阅读

- [Firecracker：安全、快速的微型虚拟机](https://firecracker-microvm.github.io/)
- [gVisor：容器应用沙箱](https://gvisor.dev/docs/)
- [Manus：了解 Manus Sandbox——您的云计算机](https://manus.im/zh-cn/blog/manus-sandbox)
- [OpenClaw：Security](https://docs.openclaw.ai/gateway/security)
- [OpenClaw：Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [OpenClaw：Multi-tenant hosting](https://docs.openclaw.ai/gateway/multi-tenant-hosting)
- [Hoox：Sandbox Provider](../../docs/architecture/sandbox-providers.md)
- [Hoox：Thread 连续上下文](../../docs/architecture/thread-continuity.md)
- [Hoox：架构总览](../../docs/architecture/overview.md)
