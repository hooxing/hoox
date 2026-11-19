# `todo_write` 参考

本文面向维护 Agent 工具、事件投影和运行进度 UI 的开发者，描述 `todo_write` 当前协议。设计理由见 [Agent 协作与 Todo](../architecture/agent-collaboration.md)。

`todo_write` 是复杂或长程任务的可选规划工具。简单任务可以直接执行；Runtime 不要求每个 Run 都存在 Todo，也不会因为没有 `in_progress` 项而拒绝其他工具。

## 参数

工具每次接收完整快照，而不是单项 patch：

| 字段 | 约束 |
| --- | --- |
| `todos` | 1–20 项 |
| `todos[].id` | 稳定 ID，匹配 `^[a-z][a-z0-9_]{0,63}$` |
| `todos[].content` | 1–240 字符 |
| `todos[].status` | `pending`、`in_progress` 或 `completed` |
| `explanation` | 可选；结构调整或执行中回退时说明原因 |

首次快照可以直接反映当前实际进度，包括把当前步骤设为 `in_progress`、把此前已完成步骤设为 `completed`；任一快照同时最多一个 `in_progress`。后续更新中，已完成项不能改写或回退，可以在完成当前项的同时把下一项设为 `in_progress`。

```json
{
  "todos": [
    { "id": "confirm_goal", "content": "确认目标和交付形式", "status": "completed" },
    { "id": "produce_result", "content": "制作交付内容", "status": "in_progress" },
    { "id": "verify_delivery", "content": "检查并交付结果", "status": "pending" }
  ],
  "explanation": "目标已确认，开始制作交付内容"
}
```

## 持久化与投影

Pi Adapter 校验参数并把命令交给 Worker。Worker 生成单调版本的 `TodoSnapshot`，通过既有 mutation lane 追加 `todo.updated`，工具成功或失败继续形成 durable Tool Observation。API 公开事件；Web 只选择最新有效快照并显示运行进度，既有工具历史仍保留在对话活动中。

完整快照让事件重放和前端投影不依赖可能丢失或乱序的 patch。领域层只校验 Todo 自身一致性，不校验 Todo 与其他工具调用的先后关系。

## 事实归属

| 层 | 主要文件 |
| --- | --- |
| Domain | `runtime-ts/packages/domain/src/todo.ts` |
| Tool Router | `runtime-ts/packages/tool-router/src/todo-write-tool.ts` |
| Prompt | `runtime-ts/packages/prompt-builder/src/index.ts` |
| Worker | `runtime-ts/apps/agent-worker/src/run-worker.ts` |
| API | `runtime-ts/apps/api/src/app.ts` |
| Web | `runtime-ts/apps/web/src/event-view.ts`、`runtime-ts/apps/web/src/workspace-view.tsx` |
