# Runtime packages

计划中的包边界：`domain`、`protocol`、`persistence`、`pi-adapter`、`prompt-builder`、`context-policy`、`tool-router`、`sandbox`、`workspace`、`resource`、`artifact` 与 `testing`。

其中 `workspace` 已实现版本化内容清单、安全物化规划、物化与可验证发布编排核心，`resource` 已实现发现、局部预览、显式导入应用核心及 PostgreSQL 目录与提升提交，`artifact` 已实现发布、完成门和授权下载应用核心；Artifact 的真实 PostgreSQL 引用以及 HTTP/UI、对象下载、Sandbox 适配器和 Revision 发布仍由后续切片完成。其他空包将在对应任务开始时实现。
