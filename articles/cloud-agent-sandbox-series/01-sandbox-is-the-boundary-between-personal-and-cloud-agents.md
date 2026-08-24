---
title: 从个人 Agent 到云端 Agent，最大的区别为什么是 Sandbox
series: 从 OpenClaw 到 Manus：为 Agent 造一台云电脑
status: draft
date: 2026-08-24
---

# 从个人 Agent 到云端 Agent，最大的区别为什么是 Sandbox

最近探索了一下 Manus 之类的云端 Agent 是如何实现的，顺手用 Codex 实现了一个叫 [Hoox](https://github.com/hooxing/hoox) 的项目。

最开始，我以为这件事的重点会是模型、Prompt、Tool Calling，或者怎样让 Agent 自己写代码、操作浏览器。真正做下去以后却发现，从一个人自己使用的个人 Agent，到很多人可以同时使用的云端 Agent，最主要的区别其实是 **Sandbox**。

不是因为“执行 Shell 很危险”这么简单。

更本质的区别是：个人 Agent 通常使用的是用户已经拥有的电脑，而云端 Agent 必须由平台为它提供一台电脑。

一旦这台电脑属于平台，问题就完全变了。

## 个人 Agent 已经天然拥有一台电脑

以 OpenClaw 这一类个人 Agent 为例，它面对的典型场景是：用户先准备好一台自己的电脑或服务器，再让 Agent 使用这台机器上的文件、浏览器、登录状态和开发环境。

在这种模型下，很多问题已经被“用户拥有这台机器”这个前提悄悄解决了：

- 文件放在哪里？就在用户自己的磁盘上。
- 依赖安装在哪里？装在用户自己的环境里。
- 浏览器登录状态属于谁？属于这台机器的主人。
- 机器什么时候关闭？由用户决定。
- Agent 把环境弄乱了怎么办？最终也是用户处理。
- 运行成本由谁承担？机器、电费和云服务器账单都属于用户。

OpenClaw 也支持 Docker、SSH 和托管 Sandbox 等执行方式，但其默认安全模型仍然是一个 Gateway 对应一个可信操作者边界。它解决的核心问题更接近：**怎样让我的 Agent 更安全、更方便地使用我提供的机器。**

这是一种合理而且非常实用的产品选择。

但是，当我们想做一个类似 Manus 的云端 Agent 时，这些前提都不存在了。

用户只打开一个网页，输入一句话：

> 调研几个开源 Agent 项目，运行它们的示例，比较实现差异，最后生成一份报告和 PPT。

他并没有为 Agent 准备 Linux，没有安装 Python、Node.js 和浏览器，也没有提供一个可以连续运行二十分钟的终端。甚至在任务提交以后，他可能直接合上电脑。

所以，平台必须替用户提供这一切。

这时候，Sandbox 不再是一个可选的安全功能，而是云端 Agent 的“电脑”。

## Sandbox 不是一个用完就删的 Docker 容器

一开始很容易把问题理解成：

```text
收到任务
→ 创建一个容器
→ 在容器里执行命令
→ 返回结果
→ 删除容器
```

这个方案做 Demo 没有问题，但只要开始支持真实用户，马上会遇到一系列无法靠 `docker run` 回答的问题。

### 这台 Sandbox 属于谁

它是属于用户、一次对话，还是一次任务？

如果每个用户永久拥有一台 Sandbox，连续性最好，但大量机器会长期空闲，成本很快失控，而且不同任务留下的进程、缓存和环境变量会相互污染。

如果每次任务都创建一台新的 Sandbox，隔离最干净，但用户上一轮安装的依赖全部消失；连续修改一个项目时，每轮都要重新下载代码、安装依赖和恢复文件。

如果每次重试都创建一台新的 Sandbox，故障隔离会更彻底，但一次 Worker 重启就可能留下多台无人管理的云电脑。

在 Hoox 里，我们最终让 Sandbox 的连续性主要跟随 Thread，也就是一段持续对话；具体执行权则属于当前 Run 的 ExecutionAttempt。Sandbox 可以在同一个 Thread 中 pause、resume 和复用，但失去租约、generation 或 capability 的旧 Worker 不能继续操作它。

这里已经不是容器编排问题了，而是所有权问题。

### 创建请求超时，Sandbox 到底创建成功了吗

接入真实 Sandbox Provider 后，会遇到一种非常麻烦的失败：结果未知。

```text
Worker 请求创建 Sandbox
→ Provider 已经创建成功
→ 网络在响应返回前中断
→ Worker 收到超时
```

这时候最危险的操作是直接重试。

第一次请求可能已经创建了一台机器，第二次重试又创建一台。数据库里没有第一台机器的身份，但它仍然在 Provider 侧运行、计费，甚至保留用户文件和后台进程。

因此，“创建 Sandbox”不能只是一段同步 API 调用。Runtime 需要持久记录：

- 使用了哪个 Provider；
- 当前处于 creating、running、paused、unknown 还是 terminated；
- 远端 Sandbox ID 是什么；
- 当前 generation 是多少；
- 哪个 Thread 拥有它；
- 哪个 Attempt 持有租约；
- 创建失败是确定失败，还是结果未知；
- 是否需要对账或清理孤儿资源。

这也是为什么 Hoox 没有在 Provider 超时时自动切换到另一家 Provider。第一次创建的结果尚未确认时，换一家重新创建，只会让外部副作用更加无法解释。

### Worker 死了，Sandbox 可能还活着

Agent Worker 和 Sandbox 是两个不同的生命周期。

Worker 可能在执行过程中崩溃，但 Sandbox 里的 Python、浏览器或构建进程仍然继续运行。新的 Worker 接管任务后，不能简单地把上一条命令再执行一次，因为旧进程可能还在写文件、访问网络，甚至已经完成了一次不可逆操作。

反过来也一样：Worker 还活着，不代表 Sandbox 真的可用。Provider 控制面显示 `running`，Sandbox 内部的文件服务、网络、代理或 ResourceFS 仍然可能没有准备好。

所以云端 Agent 需要区分：

```text
Provider 说 Sandbox 正在运行
        ≠
Sandbox 的数据面已经可用
        ≠
当前 Attempt 仍有权使用它
```

这也是 Sandbox Runtime 和普通容器封装最大的区别之一：它必须理解失败语义，而不只是提供 `create`、`exec` 和 `delete` 三个方法。

## Sandbox 可以消失，用户的工作不能消失

还有一个更关键的问题：Sandbox 最终一定会被销毁。

如果我们把 Sandbox 当作用户数据的事实源，那么机器被回收时，用户上传的文件、Agent 修改的代码和生成的报告都会一起消失。

最直接的补救方式是永久保存整块磁盘，但这很快又会带来新的问题：

- `node_modules`、浏览器缓存和临时文件是否都要保存？
- 一个长期使用的 Sandbox 磁盘可能增长到多大？
- 换一家 Sandbox Provider 后，这块磁盘还能不能恢复？
- 怎样知道 Agent 本轮到底修改了哪些文件？
- 多次保存失败后，哪个版本才是可信版本？
- Sandbox 中存在一个文件，是否意味着用户已经能够下载它？

Hoox 对这个问题的处理原则是：

> **Sandbox 是计算资源，不是业务事实源。**

我们把与文件有关的概念拆成了三层：

- **Resource**：用户上传或从资源库引用的不可变输入；
- **Workspace**：Thread 私有、可变、可版本化的工作目录；
- **Artifact**：Agent 明确发布给用户的最终交付物。

Sandbox 中的 `/workspace` 只是某个 Workspace Revision 的一次物化。Sandbox 可以被暂停、替换甚至永久销毁，只要最新 Workspace Revision 和必要的 Resource 仍然保存在平台控制的持久存储中，Runtime 就可以在另一台 Sandbox 中重新构造工作环境。

因此，真正需要保存的不是“这台机器”，而是能够重新得到当前工作状态的事实。

可以把这条关系理解成：

```text
持久化 Workspace Revision
          ↓ materialize
临时 Sandbox /workspace
          ↓ Agent 修改
候选 Workspace Revision
          ↓ commit
新的持久化 Workspace Revision
```

最终交付物还要再经过一次显式发布。Agent 在 `/workspace` 里生成了 `report.pptx`，并不代表用户已经拿到了它。文件需要离开临时 Sandbox，进入对象存储，绑定正确的 Tenant、Thread 和版本，并获得下载授权，任务才真正完成。

换句话说：

> 文件存在是计算事实，文件交付是产品事实。

## 从一个人使用到多人并发，变化的是信任边界

个人 Agent 通常可以假设操作者就是机器的主人。

云端平台则必须假设用户之间互不信任。此时“多用户并发”不是多启动几个容器那么简单，而是要保证：

- 用户 A 不能猜测 Sandbox ID 后连接用户 B 的环境；
- 一个过期 Attempt 不能继续操作已经移交的新 Sandbox；
- Sandbox 不能看到对象存储密钥、数据库身份和宿主机路径；
- 用户上传的恶意项目不能逃逸到 Worker；
- Workspace 复用不能把上一个用户或 Thread 的数据带进来；
- Artifact 下载必须重新验证租户和所有权；
- Scheduler 回收 Sandbox 时不能误杀仍在执行的任务。

因此，Hoox 中的业务代码不能直接拿一个 Sandbox ID 调用厂商 SDK。Runtime 先通过 Tenant、Thread、Workspace、Provider、generation 和 lease 等信息构造受限 capability，再由 Sandbox Adapter 执行具体操作。

Sandbox 隔离的是机器，Tool Router 限制的是能力，TenantScope 和持久化权限限制的是数据。三者解决的不是同一个问题，不能互相替代。

## 真正的分界线不是本地还是云，而是谁承担复杂性

严格来说，OpenClaw 也可以部署在 VPS，云端 Agent 也可以通过桌面客户端操作本机。因此，“本地 Agent”和“云端 Agent”并不是由进程运行在哪个机房决定的。

更准确的区别是：

> **执行环境由用户负责，还是由平台负责。**

当用户负责执行环境时，他同时承担了机器、状态、权限、持续在线和资源成本。

当平台负责执行环境时，平台就必须承担：

- 创建和回收；
- 身份和所有权；
- 多租户隔离；
- Workspace 持久化；
- 故障恢复；
- Provider 对账；
- 资源调度；
- 成本控制；
- 审计和追踪。

这也是我实现 Hoox 后最大的感受：模型循环并不是云端 Agent 最难的部分。真正困难的是，怎样让一个概率性的 Agent 安全、持续地使用一台由平台临时提供的电脑。

最后可以把整个设计收敛成三条不变量：

1. **Sandbox 可以消失，任务不能消失。**
2. **Sandbox 可以消失，用户的工作不能消失。**
3. **Sandbox 可以复用，但旧的执行权不能复用。**

后面的文章会继续沿着这三条不变量展开：一台 Sandbox 到底应该属于 Thread 还是 Run、创建超时后怎样对账、Worker 崩溃后怎样处理仍在运行的进程、Workspace 如何在不同 Sandbox 之间恢复，以及每个用户都需要一台云电脑时，平台如何控制成本。

## 延伸阅读

- [Manus：了解 Manus Sandbox——您的云计算机](https://manus.im/zh-cn/blog/manus-sandbox)
- [OpenClaw：Security](https://docs.openclaw.ai/gateway/security)
- [OpenClaw：Sandboxing](https://docs.openclaw.ai/gateway/sandboxing)
- [OpenClaw：Multi-tenant hosting](https://docs.openclaw.ai/gateway/multi-tenant-hosting)
- [Hoox：Sandbox Provider](../../docs/architecture/sandbox-providers.md)
- [Hoox：Thread 连续上下文](../../docs/architecture/thread-continuity.md)
- [Hoox：架构总览](../../docs/architecture/overview.md)
