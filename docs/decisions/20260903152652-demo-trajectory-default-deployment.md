# ADR-20260903152652：Demo 默认部署受保护的内部轨迹查看器

- 状态：已接受
- 日期：2026-09-03
- 决策者：Runtime 维护者
- 关联决策：部分替代 [ADR-20260815182655](20260815182655-local-internal-trajectory-viewer.md) 的禁止反向代理结论，以及[后台模型用量指标与开发轨迹入口边界](20260824150132-admin-model-usage-metrics-and-development-trajectory-link.md)的仅 development 构建入口结论

## 背景

Demo 环境已经通过单机 Compose 和同源 Nginx 提供用户 Web、Admin Web 与受保护的 Admin API，但内部轨迹查看器仍需维护者在目标主机外单独启动。访问 `https://hoox.aisay.cc/trajectory/` 时会落入用户 Web 的 SPA 回退，无法检查 Demo Worker 实际产生的模型步骤、工具生命周期和模型报文。

轨迹正文可能包含完整 Prompt、思考、工具参数和模型响应，不能作为匿名 Demo 内容公开。现有 Demo 管理员 Hoox Session 已能由 Nginx `auth_request` 验证，但普通页面导航不会自动携带 Bearer，因此不能直接对 HTML 入口使用同一网关方式。

## 备选方案

### 方案 A：继续只提供本机回环查看器

安全边界最小，但 Demo 的远程排障仍依赖登录服务器和端口转发，不满足默认部署需求。

### 方案 B：公开整个 `/trajectory/`

实现最简单，但匿名访问者能够读取跨 Run 的敏感正文，不能接受。

### 方案 C：公开无数据的页面外壳，只对轨迹 API 使用 Demo 管理员会话鉴权

查看器继续在目标主机回环监听。Nginx 提供同源子路径，页面从同源 `localStorage` 读取未过期 Hoox Session，只把 Bearer 发送到 `/trajectory/api/` 的网关鉴权子请求；Nginx 鉴权后清空转发给查看器的 `Authorization`。选择此方案。

## 决策

1. Demo 镜像默认构建 `@hoox/trajectory-web` 及其运行闭包，Compose 默认启动只读、非特权的 `trajectory` 容器，并只在宿主机 `127.0.0.1:4188` 监听。
2. Demo Worker 默认启用 `MODEL_WIRE_TRACE_ENABLED=true`。Worker 以读写方式、查看器以只读方式挂载同一轨迹卷；查看器仍只接受固定标识符、普通文件、大小上限和受控根目录。
3. 轨迹卷按不可变 release ID 命名。每次发布使用新卷，回滚恢复上一 release 的卷；发布清理旧 release 时同时删除对应旧卷，轨迹不会跨全部历史发布无限累积。
4. Nginx 将 `/trajectory/` 转发到回环查看器，并把 `/trajectory` 规范化为带尾斜杠路径。页面的 API URL 相对当前页面解析，因此本地根路径和 Demo 子路径使用同一构建。
5. `/trajectory/` HTML 外壳可以匿名加载，但不包含轨迹数据；`/trajectory/api/` 必须通过现有 Demo 管理员 Hoox Session 的 `auth_request`。无会话或非管理员会话返回 `401`，鉴权成功后 Nginx 清空上游 `Authorization`，查看器进程不接收 Session Token。
6. Admin Web 的 development 构建继续链接 `http://127.0.0.1:4188`；以 `/admin/` 为 base 的 Demo 构建改为链接同源 `/trajectory/`。其他 production 构建不显示入口。
7. 该例外只适用于受控 Demo 拓扑，不把轨迹查看器加入 production API、Scheduler、Worker 镜像门禁或通用生产发布清单。

## 理由

方案 C 复用已经部署并验收的 Demo 管理员身份，不新增长期共享密码，也不把 Admin Control development Token交给浏览器。回环监听、Nginx 鉴权和只读查看器卷形成分层边界；release 级卷同时让回滚可恢复、历史数据可随旧发布一起清理。

## 影响

- Demo 镜像和 Compose 增加轨迹构建闭包、一个常驻容器和一个 release 级数据卷；Worker 会产生敏感诊断文件。
- 页面外壳可公开探测，但列表、详情和模型报文读取都要求 Demo 管理员会话。
- 每次发布切换到空轨迹卷，因此新发布后只能看到该 release 产生的记录；回滚后恢复上一 release 的记录。
- Demo CD 必须同时验证回环页面、公开页面、未授权 `401` 和带管理员会话的轨迹 API。
- production 的禁用诊断和保留清理要求不变。

## 验证

- Demo 部署契约测试覆盖镜像构建、Compose 服务、Worker/查看器卷权限、release 级卷名、Nginx 路由、鉴权、Token 清除、回滚和旧卷清理。
- 轨迹页面测试覆盖相对子路径 URL、同源 Hoox Session 读取及 Bearer 请求头。
- Admin Web 测试覆盖 development 回环链接、Demo 同源链接和其他 production 构建隐藏入口。
- 发布脚本验证 `/trajectory/` 可访问、匿名 `/trajectory/api/threads` 返回 `401`，管理员会话请求成功。

## 可逆性

移除 Demo 镜像构建过滤器、Compose 服务和卷、Nginx 子路径、Admin Web Demo 链接及 CD 验收即可回退。旧 release 的轨迹卷可以在对应容器停止后删除；该改动没有数据库迁移或公开业务协议变化。
