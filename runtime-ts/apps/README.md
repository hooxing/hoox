# Runtime 应用

本目录保存可部署进程和前端应用。应用入口负责协议适配、依赖装配、进程生命周期与健康状态，不承载可复用领域规则。

| 应用 | 职责 | Production |
| --- | --- | --- |
| `api` | HTTP API、身份、TenantScope、命令和读取投影 | 核心进程 |
| `agent-worker` | Run 领取、模型与工具执行、结果收敛 | 核心进程 |
| `scheduler` | 清理、恢复、定时任务和后台协调 | 核心进程 |
| `web` | 用户工作台 | 外部身份与部署仍需产品集成 |
| `skill-admin-api` | Skill 提交、审核、发布和撤销 | 独立管理面 |
| `admin-web` | Skill 管理前端 | 独立管理面 |
| `trajectory-web` | 本地内部轨迹查看器 | 仅 development |

共享逻辑应下沉到 `runtime-ts/packages`。应用之间出现新的直接依赖前，应确认复用逻辑是否应该提取为共享包。

完整说明见 [`docs/architecture/repository-map.md`](../../docs/architecture/repository-map.md)。
