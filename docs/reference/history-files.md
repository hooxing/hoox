# 历史文件与 ResourceFS

本文面向使用或维护历史文件能力的开发者，说明 Web/API 云盘与 Sandbox 只读目录的当前契约。历史实施拆解保存在[归档计划](../archive/plans/history-files-virtual-directory.md)。

## 用户入口

`GET /v1/me/history-files` 按当前认证 `TenantScope` 搜索和分页浏览历史任务文件，并通过固定 ResourceVersion 签发短期下载地址。路径中的 `me` 不表示只允许个人 Tenant；Web 云盘分别以个人空间或当前团队空间调用同一契约。默认时间窗口为最近六个月，默认每页 24 项，最大 50 项。

云盘和消息附件引用使用 Resource/ResourceVersion 身份，不复制同一 Tenant 内尚未使用的文件；列表和下载都会重新验证当前 Tenant 与 Membership。个人任务需要使用团队文件时，必须通过跨空间导入创建个人 ResourceVersion 副本，不能长期复用团队权限。

## Sandbox 目录

当当前 Session 具备 ResourceFS 能力时，模型可以读取：

```text
/history       当前 Tenant 最近六个月有文件的历史任务
/thread-files  当前 Thread 的稳定历史文件入口
/resources     ResourceFS 底层只读视图和 Skill 市场资源
/workspace     当前 Thread 的可写 Workspace
```

`/history` 使用稳定语义目录名并处理重名，`/thread-files` 始终指向当前 Thread。历史和资源目录只读，不暴露 Tenant、Thread、Resource、Version、Blob key 或签名 URL 作为主要路径。

## 数据与 Provider

PostgreSQL 保存目录、所有权和不可变版本事实，S3 兼容存储保存 Blob。CubeSandbox 通过受控 Volume 读取 ResourceFS；E2B 由 Worker 物化同一能力范围的固定快照。Sandbox 不是文件事实源，丢失或重建后必须从持久事实恢复。

## 跨空间规则

个人空间通过 `POST /v1/me/team-files/import` 导入团队文件。API 先验证个人目标空间和来源团队 Membership，再读取固定来源版本并在个人 Tenant 中创建副本。成员退出团队后，已导入的个人副本继续可用，但不能继续浏览该团队或导入新文件。

普通历史列表、下载和 Sandbox 路径都只服务当前 Tenant，不自动合并多个团队，也不允许用个人身份跨 Tenant 读取原文件。

## 当前限制

- 历史窗口固定为最近六个月，尚未提供用户自定义保留范围。
- Web 团队云盘一次只展示当前选择的团队，不聚合全部团队文件。
- 目录枚举适合先按任务名和文件名缩小范围，不应无差别读取大量历史正文。
