# ADR-0104：活跃 Sandbox 存活窗口与命令数据面熔断

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 团队
- 关联任务/PR：PPTX Skill 运行中 Sandbox 提前消失并触发 50 次命令重试
- 替代关系：补充 ADR-0066、ADR-0069 与 ADR-0103

## 背景

真实模型报文与 CubeSandbox 时间线证明：同一个 Run 的前六次命令成功，模板缺少 Node.js 后模型开始安装依赖；
Sandbox 从创建起满 120 秒被平台按 TTL 处理，随后 `exec_command` 的数据面请求全部失败。Runtime 将每次失败作为
普通 Tool Error 交还模型，没有运行时熔断，因此模型又发起了 50 次无效调用。

Thread Session reuse 临时关闭时，一次性 acquire 没有 `onTimeout=pause`，120 秒会直接销毁 Sandbox。Thread
Session reuse 开启时虽然 create 已显式使用 `onTimeout=pause` 与 `autoResume=true`，但 120 秒仍不足以覆盖一个
最长 15 分钟的活跃 Run。另一方面，暂停 Session 的默认保留期只有十分钟，也不符合跨时段继续会话的产品语义。

## 备选方案

### 保留 120 秒 TTL，只增加模型提示

不能阻止平台在活跃任务中回收资源，也不能强制模型停止重试。

### 每次命令调用刷新 Provider TTL

最接近严格的滑动空闲窗口，但当前已验证 SDK 没有续期能力，直接依赖未冻结的私有 API 会扩大 Provider
兼容边界。

### 用 Worker 截止时间约束活跃窗口，并对数据面连续失败熔断

让 Provider TTL 覆盖完整 Run 与安全收敛窗口；正常队列清空仍立即 pause，不把较长 TTL 当作热保留策略。
暂停 Session 保留一天后再由 Scheduler 销毁。命令数据面连续失败达到固定阈值后由 Runtime 停止 Provider
续轮。

## 选择

选择第三种方案：

- 新增 `AGENT_WORKER_RUN_TIMEOUT_MS`，默认 900000 毫秒，并真实传给 `RunWorker`；
- `CUBESANDBOX_SESSION_TTL_SECONDS` 默认改为 1200 秒；配置解析强制
  `session TTL >= Run timeout + Sandbox lifecycle timeout`，不允许再次形成活跃期内回收；
- Thread Session create 继续使用 `onTimeout=pause` 与 `autoResume=true`。正常 Run 完成且队列清空时沿用既有
  状态机立即 pause；下次输入通过 connect 自动恢复；
- `THREAD_SANDBOX_PAUSED_RETENTION_SECONDS` 默认改为 86400 秒，由 Scheduler 在暂停满一天后终止；
- 同一 Pi Session 内，`exec_command` 连续三次遇到 Sandbox 基础设施错误时打开熔断器。第三个 durable
  失败回执完成后阻止下一次 Provider 请求，Attempt 进入 `recovery_required/SANDBOX_FAILED` 并执行既有清理；
- 正常非零退出码、调用超时、取消与参数错误不计入基础设施熔断；任一成功命令会清零连续失败计数；
- Sandbox 模板必须预装 Skill 宣称已预装的运行时依赖，缺依赖属于模板发布错误，不能让模型在每个 Run 内临时
  安装来规避。

## 理由

较长 TTL 只是 Worker 崩溃时的 Provider 兜底，正常资源释放仍由 durable Thread lifecycle 决定，因此不会让
每个成功任务无条件热运行 20 分钟。一天的 paused retention 保留可恢复快照而不占用运行中的 MicroVM；到期后
仍有明确的最终回收点。三次阈值允许短暂数据面抖动自行恢复，同时把最坏 Provider 续轮数从无界降为三次。

## 影响

### 正面影响

- 活跃 Run 不再因两分钟绝对 TTL 丢失 Sandbox；
- 暂停后的 Thread Sandbox 可在一天内自动恢复；
- 命令服务永久消失时不会继续消耗模型 token、工具许可和队列时间。

### 负面影响与成本

- Worker 崩溃后，Provider 自动 pause 的兜底窗口从两分钟增加到二十分钟；
- 三次连续基础设施错误会结束当前 Attempt，暂态故障恢复后需要由恢复流程或新输入继续。

### 安全、数据与运维影响

- 配置不变量在进程启动时失败关闭；
- 熔断只读取适配器内部错误类型，不解析模型或上游私密正文；
- paused retention 改变资源保留成本，Scheduler 仍负责最终终止。

## 验证

- 配置测试验证默认值、自定义值及 TTL 小于 Run+收敛窗口时失败关闭；
- Tool 单元测试验证第三次错误打开熔断、第四次不触碰 Sandbox、成功调用清零计数；
- Pi 纵向测试验证第四次 Provider 请求不会发生；
- Worker 纵向测试验证 Attempt 进入 `recovery_required/SANDBOX_FAILED` 且执行 Sandbox settle。

## 可逆性与回退

可回退新环境变量、默认值、不变量与熔断器，不涉及数据库迁移。若平台后续提供并验证 TTL 续期 API，可新增
滑动续期后缩短 Provider fallback TTL；在取得真实能力证据前不替换当前方案。

## 后续工作

- 在 CubeSandbox SDK 正式暴露续期接口后补充滑动空闲窗口 Spike；
- 将 PPTX 及其他 Skill 的运行时依赖纳入模板构建和发布门禁。

## 实施记录

- 2026-08-04：完成配置不变量、一天 paused retention、三次命令基础设施熔断及自动化测试。
- 2026-08-04：提交固定摘要的 PPTX Sandbox 模板配方与构建期依赖契约，避免 Run 内临时安装。
- 2026-08-04：实机确认命令服务不会继承镜像 `NODE_PATH`，模板增加根级 `/node_modules` 解析路径；以新镜像标签创建模板后完成真实 PPTX 生成及 pause/resume 冒烟。
