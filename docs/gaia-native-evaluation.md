# GAIA 当前 Runtime 原生评测

这个入口用于回答“当前 Runtime 在现有模型、工具和 Sandbox 下能做到什么”，不用于复现 GAIA 官方排行榜配置。它直接把公开 Level 1 子集的题目和附件送入现有 Thread/Run API，不替换系统提示、工具或执行环境。

## 运行边界

- 使用调用者指定的当前角色；开发环境默认是 `dev-user-a`。
- 必须在 API、Worker 和评测进程中都设置 `MEM0_MEMORY_ENABLED=false`，否则评测脚本失败关闭。
- 每道题创建一个普通 Thread，任务记录保留，不自动归档或删除。
- 报告写入 `.tmp/gaia-native-eval`，包含 Runtime 回答、Run/Execution 状态、耗时、工具调用数量、运行通知和错误。
- 默认跑公开题目列表的前三道。入口不持有 GAIA 标准答案，也不会调用外部 `/submit`，因此输出是未评分的能力证据，不是官方 GAIA 分数。

## 用法

先以关闭记忆的同一环境启动 API 和 Worker，再运行：

```powershell
$env:MEM0_MEMORY_ENABLED = "false"
corepack pnpm eval:gaia:native -- --limit 3
```

按公开 `task_id` 选择题目：

```powershell
$env:MEM0_MEMORY_ENABLED = "false"
corepack pnpm eval:gaia:native -- --task-id <task_id>
```

可通过 `GAIA_EVAL_API_BASE_URL`、`GAIA_EVAL_AUTH_TOKEN`、`GAIA_EVAL_QUESTIONS_URL`、`GAIA_EVAL_FILES_BASE_URL` 和 `GAIA_EVAL_OUTPUT_DIR` 覆盖连接和输出位置。鉴权令牌只用于请求，不写入报告；报告只把默认开发身份记为 `dev-user-a`，其他身份统一记为 `custom`。

如需形成可比较分数，应另行提供有权使用的答案文件和评分规则，或由人工审阅结果。不要把本入口的 Run 成功率当成题目正确率。
