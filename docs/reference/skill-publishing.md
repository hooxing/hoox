# Skill 发布参考

本文面向平台 Skill 管理员与受授权 Skill 发布者，说明后台命名空间管理和 Skill 发布 HTTP 接口。接口使用后台现有 Hoox 会话认证；发布服务继续执行完整包校验，发布者权限不改变 Skill 的运行能力。

## 命名空间

当前 Skill 规范键此前没有命名空间前缀语义。发布者上传时使用 `namespace.skill-name`，首个点号前的部分作为命名空间；命名空间为 1–63 个小写字母、数字、下划线或连字符，且以小写字母或数字开头。旧的无前缀规范键继续由平台 Skill 管理员管理，不会自动授予发布者访问权。

## 权限

| 操作 | 平台 Skill 管理员 | 命名空间发布者 | 普通用户 |
| --- | --- | --- | --- |
| 创建命名空间、授权或撤销发布者 | 是 | 否 | 否 |
| 查看命名空间 Skill 发布申请 | 全部 | 仅当前授权命名空间 | 否 |
| 上传、提交自己创建的申请 | 全部 | 仅授权命名空间 | 否 |
| 发布或撤回 Skill 版本 | 全部 | 仅授权命名空间 | 否 |
| 审核申请或访问其他管理页面 | 是 | 否 | 否 |

跨命名空间、已撤销授权或不存在资源的申请访问统一返回 404，不通过响应区分资源是否存在。持久层 RLS 独立校验当前用户，服务层授权不能替代数据库作用域。

## 命名空间管理接口

| 方法与路径 | 权限 | 用途 |
| --- | --- | --- |
| `GET /v1/admin/control/skill-publication-access` | Skill 管理员、发布者 | 返回当前角色和可用命名空间 |
| `GET /v1/admin/control/skill-namespaces` | Skill 管理员 | 列出命名空间及有效发布者 |
| `POST /v1/admin/control/skill-namespaces` | Skill 管理员 | 创建命名空间，JSON `{ "namespace": "team-tools" }` |
| `POST /v1/admin/control/skill-namespaces/{namespace}/publishers` | Skill 管理员 | 授权用户，JSON `{ "userId": "user_..." }` |
| `DELETE /v1/admin/control/skill-namespaces/{namespace}/publishers/{userId}` | Skill 管理员 | 撤销有效授权 |

命名空间、授权和撤销操作写入独立审计。重复授予有效授权不会重置授予时间或重复写审计；撤销后再次授权会生成新的授予时间和审计记录。

## 发布接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /v1/admin/skill-submissions` | 分页列出当前可见的申请 |
| `GET /v1/admin/skill-submissions/{submissionId}` | 读取申请详情 |
| `POST /v1/admin/skill-submissions` | 上传完整 Skill 包并创建申请 |
| `POST /v1/admin/skill-submissions/{submissionId}/submit` | 提交本人创建的申请 |
| `POST /v1/admin/skill-submissions/{submissionId}/review` | 管理员审核；发布者不可调用 |
| `POST /v1/admin/skill-submissions/{submissionId}/publish` | 发布完整校验通过的版本 |
| `POST /v1/admin/skill-submissions/{submissionId}/revoke` | 撤回已发布版本 |

写请求遵循现有 `Idempotency-Key` 与版本令牌契约。发布者只能在申请规范键的命名空间授权仍有效时上传、发布或撤回。发布与撤回审计包含操作者、命名空间及 Skill 版本。包校验失败不会创建申请；已发布内容保持受限信任级别，工具能力仍由平台白名单和 Agent 配置共同约束。
