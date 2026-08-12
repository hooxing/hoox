# ADR-0151：开发 Worker 启动前自编译应用入口

- 状态：已接受
- 日期：2026-08-12
- 决策者：Runtime 团队
- 关联任务/PR：修复本地 Worker 重启后仍加载陈旧 `dist`
- 替代关系：细化 ADR-0040 的开发 Worker 启动流程，不改变生产构建与部署入口

## 背景

Agent Worker 的根级 `pnpm dev:worker` 会先构建依赖闭包，再执行包级 `dev`；但开发者和本地脚本也可以直接运行 `pnpm --filter @cube-runtime/agent-worker dev`。原包级 `dev` 只执行 `node dist/development-main.js`，不会编译当前应用。

本次故障中，心跳持久层重试修复已于 2026-08-12 09:57 提交，但运行中的 Worker 创建于 09:29，且 `runtime-ts/apps/agent-worker/dist/run-worker.js` 仍停留在 09:26。10:04 的新追踪因此再次表现为旧逻辑的 `PERSISTENCE_UNAVAILABLE`。直接重启包级 `dev` 仍可能继续加载旧产物，造成“源码已修复、运行行为未变化”的误判。

## 决策驱动因素

- 开发启动必须加载当前 Agent Worker 源码对应的应用产物；
- 不在运行时使用 `tsx` 绕过既有编译产物和 Node 生产形态；
- 不重复构建完整依赖闭包，避免每次包级启动触发慢速或受文件锁影响的 vendor 清理；
- 根级 `dev:worker`、包级 `dev` 和人工重启都应得到一致的应用入口语义；
- 生产入口继续只加载镜像构建阶段生成的 `dist`。

## 备选方案

### 方案 A：继续要求调用者先手工 build

不改代码，但依赖人工记忆；直接包级重启很容易继续使用陈旧产物，本次故障已证明该约定不可靠。

### 方案 B：包级 dev 启动前只编译 Agent Worker 应用

把包级脚本改为先执行 `tsc -p tsconfig.json`，成功后再启动 `dist/development-main.js`。根级命令仍负责依赖闭包构建；包级重启只刷新当前应用，避免不必要地清理或重建 vendor `dist`。

### 方案 C：开发环境直接用 tsx 运行源码

可避免显式编译，但会让开发运行形态偏离生产 Node 加载已编译 ESM 的边界，并可能掩盖导出、路径或构建配置错误，因此拒绝。

## 选择

采用方案 B：

1. `@cube-runtime/agent-worker` 的包级 `dev` 固定为 `tsc -p tsconfig.json && node --env-file-if-exists=../../../.env dist/development-main.js`；
2. TypeScript 编译失败时不启动旧 Worker；
3. 根级 `pnpm dev:worker` 保持依赖闭包构建后调用包级 `dev`，即使当前应用被重复编译也优先保证入口新鲜；
4. 生产 `start:production` 不增加运行时编译，仍由发布构建门禁保证产物完整；
5. 增加脚本契约测试，防止后续把包级 `dev` 退回为直接加载旧 `dist`。

## 理由

Agent Worker 应用自身使用 `tsc`，增量编译成本远低于完整依赖闭包构建，也不会清理 CubeSandbox SDK 的输出文件。将应用编译放入包级 `dev` 是覆盖直接启动、脚本启动和人工重启的最小可靠边界。编译成功后仍使用与生产一致的 Node ESM 入口，保留构建产物验证价值。

## 影响

### 正面影响

- 包级 Worker 重启不会再静默加载陈旧应用代码；
- 源码修复与运行中 `dist` 的对应关系更清晰；
- TypeScript 错误会在服务领取任务前暴露。

### 负面影响与成本

- 每次包级 `dev` 启动增加一次 Agent Worker 应用编译；
- 根级 `dev:worker` 当前会在依赖构建后再次编译应用，存在少量重复工作。

### 安全、数据与运维影响

不改变 Tenant、数据库、模型、Sandbox 或工具权限，不新增迁移。仅影响 development 启动；生产发布入口和运行时权限不变。

## 验证

- 契约测试断言包级 `dev` 在 Node 启动前执行当前应用 `tsc`；
- 执行 Agent Worker build、typecheck 和相关测试；
- 检查生成的 `dist/run-worker.js` 包含最新持久层重试逻辑；
- 重启 development Worker，确认启动时间晚于编译产物时间且日志显示成功启动。

## 可逆性与回退

仅修改 package script 和测试，可直接回退；回退后必须恢复人工“先 build 后启动”的操作约束，否则陈旧 `dist` 风险重新出现。
