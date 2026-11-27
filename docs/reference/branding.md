# 平台品牌设置

本文供部署方和前端/API 维护者查找白标配置的字段、接口与生效范围。权限、持久化和安全不变量见[后台控制面](../architecture/admin-control-plane.md#平台品牌)，部署操作见[部署指南](../operations/demo-cd.md#品牌定制)。品牌内容全部公开可读，不得填写密钥或内部资料。

## 字段与默认值

`BrandConfiguration` 是完整配置而非部分更新；字段和嵌套链接拒绝未知属性。

| 字段 | 默认值 | 限制 |
| --- | --- | --- |
| `productName` | `Hoox` | 去除首尾空白后非空，输入最多 60 字符，拒绝控制字符；按纯文本显示 |
| `logoDataUrl` | `null` | 仅 PNG / JPEG / WebP Base64 data URL，解码后最多 48 KiB，校验 MIME 与文件签名；SVG 和远程 URL 一律拒绝 |
| `primaryColor` | `null` | 仅 `#RRGGBB`，大小写均可；`null` 不覆盖既有主题；主按钮三态与自动黑/白前景至少 4.5:1 对比度 |
| `footerLinks` | `[]` | 最多 5 项；每项仅 `text`（非空、最多 60 字符）和 `url`（最多 2048 字符）；HTTPS 禁止凭据，mailto 必须含收件地址且禁止查询、片段和 CR/LF 注入；不接受 HTTP、相对路径或其他协议 |
| `hiddenModules` | `[]` | 去重的白名单枚举，见下表；不是权限控制 |

`logoDataUrl=null` 使用默认图标；定制产品名且没有自定义 Logo 时，工作台横版字标改为产品名纯文本，不继续展示 Hoox 字标。产品名和 Logo 均未配置时保留原有图片 DOM。页脚为空时不添加页脚 DOM。Logo 以普通图片展示，不使用 SVG 内联、`object`、`iframe` 或 HTML 注入。

| 模块枚举 | 隐藏范围 |
| --- | --- |
| `team_spaces` | 团队切换/任务列表、团队中心与管理入口、云盘的团队来源、个性化的团队入口 |
| `artifacts` | Run 回复下方的集中交付文件面板；不改写已有回复或其中的文件引用 |
| `history_files` | 云盘入口与弹窗、输入框历史文件检索/选择；本地上传不受影响 |
| `skills` | 技能中心入口和弹窗；不改变 Agent 已启用的 Skill |
| `automations` | 定时任务入口和弹窗；不会暂停已创建的任务 |

## HTTP 接口

均使用既有 `{ requestId, data }` 成功信封和服务端错误信封。匿名读取位于主 API；管理读写位于 Admin Control API。浏览器的 `/api` 是同源反向代理前缀，不是上游路由的一部分。

| 方法与路径 | 身份 | `data` 或请求 |
| --- | --- | --- |
| `GET /v1/public/branding` | 无需登录 | 仅完整 `BrandConfiguration`，不含 generation、操作者、时间、审计、安装状态或部署秘密；`Cache-Control: no-store` |
| `GET /v1/admin/control/branding` | 有效平台 `admin` | `{ generation, configuration }` |
| `PUT /v1/admin/control/branding` | 有效平台 `admin` | JSON `{ requestId, expectedGeneration, configuration }`，返回 `{ generation, configuration }` |

保存的 `requestId` 是 8–128 位字母、数字、下划线或连字符；`expectedGeneration` 是当前管理读取的非负整数。内容相同且操作者相同的同键重试返回该次保存结果；同键不同输入或旧 generation 返回 409。管理身份缺失、角色非 `admin` 或被禁用时返回 401；非法字段返回 400。未知结果重试必须保留原请求；确认并发冲突后刷新，显式合并再保存，不能自动覆盖。

读取后的品牌在工作台和后台登录页、应用字标、文档标题、站点图标、主题按钮和页脚应用。用户页面不依赖管理端点；加载失败保留默认外观，不阻塞登录。动态品牌不改写静态 Landing、分享元数据或已安装 PWA 的名称与 manifest 图标。自定义页脚链接仅为导航，不提供隐私或条款正文。

## Hoox 开源署名

公开首页、工作台和后台在每次页面加载时，都会在浏览器开发者工具的控制台输出一次 Hoox 署名和[项目仓库链接](https://github.com/hooxing/hoox)。页面源代码也保留 `generator` 元标签和含仓库链接的注释。白标只改变产品外观，不能关闭或替换这些署名。

## 编辑与恢复默认

后台「系统 → 品牌设置」支持编辑、上传位图、局部预览和恢复默认。预览只改变预览区域；保存后才持久化并应用于当前后台。其他标签页刷新后读取新配置。

「恢复默认」只替换草稿，必须再保存才生效；使用当前 generation 写入完整默认配置并产生审计。不要以删除数据库行或回退历史迁移恢复外观。品牌配置随数据库备份；静态默认素材不需替换。没有新增环境变量、对象存储桶或图片外链依赖。
