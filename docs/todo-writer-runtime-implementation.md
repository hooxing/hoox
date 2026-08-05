# Todo Writer Runtime 实现说明

## 结论

Pi `@earendil-works/pi-coding-agent@0.82.1` 没有内置 Plan/Todo 工具，默认工具只有 `read`、`bash`、`edit`、`write`、
`grep`、`find` 和 `ls`。Pi 支持通过 `defineTool` 注册自定义工具，因此 Cube Runtime 以自定义 `todo_write` 实现
Agent 自主规划，并复用现有 Run 事件、Tool Observation、API 增量读取和运行进度 UI。

这不是强制工作流：系统提示词要求 Agent 只在复杂或长程任务中自主使用，简单任务可以直接完成。Runtime 不检查
Todo 是否存在，也不会因为没有 `in_progress` 而拒绝读取、搜索、编辑、执行或交付工具。

## Agent 使用流程

1. 判断任务需要多个可验证步骤时，调用 `todo_write` 创建清单，首次所有步骤为 `pending`。
2. 准备开始某一步时，提交完整清单并将该项改为 `in_progress`。
3. 完成后，将该项改为 `completed`；可以在同一次更新中把下一项改为 `in_progress`。
4. 发现需要增删、改名或调整顺序时，提交新的完整清单，并用 `explanation` 说明原因。
5. 全部步骤完成后，提交全部为 `completed` 的最终快照。

示例参数：

```json
{
  "todos": [
    { "id": "confirm_goal", "content": "确认目标和交付形式", "status": "completed" },
    { "id": "produce_result", "content": "制作交付内容", "status": "in_progress" },
    { "id": "verify_delivery", "content": "检查并交付结果", "status": "pending" }
  ]
}
```

## 工具协议

`todo_write` 每次接收完整快照，而不是单项 patch：

| 字段 | 约束 |
|---|---|
| `todos` | 1–20 项 |
| `todos[].id` | 稳定 ID，匹配 `^[a-z][a-z0-9_]{0,63}$` |
| `todos[].content` | 1–240 字符 |
| `todos[].status` | `pending`、`in_progress` 或 `completed` |
| `explanation` | 可选，1–1000 字符；结构调整或执行中回退时必填 |

完整快照让 Worker、事件重放和前端投影不必依赖丢失或乱序的 patch。领域层只校验 Todo 自身一致性：首次全 pending、
同时最多一个 in_progress、完成项不可改写。它不校验 Todo 与其他工具调用的先后关系。

## Runtime 数据流

- Pi Adapter 注册 `todo_write`，把参数交给生产 `PiWorkerSessionFactory`。
- Factory 确认同一 `callId` 已产生真实 `tool.started` 并形成 durable `tool_call`，再调用 Worker 的窄端口。
- RunWorker 使用领域函数生成单调版本 `TodoSnapshot`，通过现有 mutation lane 追加 `todo.updated`。
- 工具成功或失败继续进入既有 durable Tool Observation，保证 Rollout 中的 tool call/result 可恢复配对。
- API 公开 `todo.updated`；Web 忽略无效快照，只选择最新有效快照。
- “运行进度”卡片显示完成数、待办、执行中和已完成状态；清单可以手动折叠，执行中默认展开，成功、失败或取消后默认收起，折叠时仍显示当前步骤和完成比例；既有工具历史仍留在对话活动区域。

`todo.updated` 示例：

```json
{
  "type": "todo.updated",
  "snapshot": {
    "schemaVersion": 1,
    "version": 2,
    "todos": [
      { "id": "confirm_goal", "content": "确认目标和交付形式", "status": "completed" },
      { "id": "produce_result", "content": "制作交付内容", "status": "in_progress" }
    ]
  }
}
```

## 修改位置

| 层 | 主要文件 | 职责 |
|---|---|---|
| Domain | `runtime-ts/packages/domain/src/todo.ts` | Todo 状态、约束、版本更新 |
| Pi Adapter | `runtime-ts/packages/pi-adapter/src/todo-write-tool.ts` | 工具 Schema、执行与 Tool Observation |
| Prompt | `runtime-ts/packages/prompt-builder/src/index.ts` | 复杂任务自主规划规则，Prompt v8 |
| Worker Contract | `runtime-ts/packages/run-contracts/src/ports.ts` | `writeTodo` 窄端口 |
| Worker | `runtime-ts/apps/agent-worker/src/run-worker.ts` | 追加 `todo.updated` durable 事实 |
| API | `runtime-ts/apps/api/src/app.ts` | 公开 Todo 事件 |
| Web | `runtime-ts/apps/web/src/event-view.ts`、`workspace-view.tsx` | 最新快照投影与运行进度展示 |

架构决策见 [ADR-0113](decisions/0113-agent-todo-writer-and-run-progress.md)。
