# hoox 命令行

本文面向用配置文件管理 Agent 的平台管理员与 CI 调用方，定义 `@hoox/cli` 的命令、凭据、输出和失败语义。[Agent 配置文件](agent-configuration.md)拥有 YAML 字段与后台导入导出接口的契约。

## 构建与安装

在仓库根目录执行：

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @hoox/cli... build
node runtime-ts/packages/cli/dist/hoox.js --help
```

CLI 的 `bin` 名称是 `hoox`，运行需要 Node.js 20 或更高版本。构建将同一份 protocol 校验器和 CLI 专用 Tool Router 文件边界打包为独立 ESM 可执行文件；发布目录为 `runtime-ts/packages/cli/dist`，发布包不依赖未发布的私有 workspace 包。可在 CLI 包目录执行 `corepack pnpm pack` 生成安装包，再通过 `npm install -g /path/to/hoox-cli-0.1.0.tgz` 安装；以下示例使用安装后的 `hoox`。

## 后台凭据与连接

CLI 访问后台控制面，不访问公开 API。`HOOX_URL` 必须指向后台 API 的 origin，例如 `https://control.example.invalid`；不能包含用户信息、路径、查询或片段。远程地址必须 HTTPS；本机 `localhost`、`127.0.0.1` 和 `[::1]` 可以使用 HTTP，开发默认管理 API 端口为 `3003`。CLI 不自动加载 `.env`。

凭据从 `HOOX_TOKEN` 或 `--token-file <file>` 读取，指定文件时优先使用文件；文件可以带结尾换行，最大 8192 字节。不要在命令参数中放明文令牌，CLI 不提供 `--token` 参数，也不打印凭据、底层网络异常或原始错误响应。

推荐使用后台访问令牌：平台管理员在后台「系统 → 后台访问令牌」创建，选择 Agent 配置读取或写入权限。写入权限包含读取；有效期默认 90 天，也可选择更短期限。令牌明文只在创建成功时显示一次，关闭后无法恢复；请立即保存到 CI Secret 或受保护的凭据文件。服务端只存随机盐哈希，每次请求复核创建者当前后台权限，令牌可随时撤销。访问令牌只允许访问 Agent 配置路由，不能管理令牌或访问其他后台功能。

`HOOX_TOKEN` 和 `--token-file` 也接受现有后台 JWT，作为兼容备选。JWT 由部署方现有受信签发流程提供：`aud` 必须匹配 `ADMIN_CONTROL_JWT_AUDIENCE`，不能使用公开 API audience；`sub` 必须是当前有效的后台身份。不要把 `ADMIN_CONTROL_JWT_SIGNING_KEYS` 交给 CLI。JWT 没有逐令牌撤销和路由作用域；创建者失权后仍会按当前后台角色复核。管理会话也可通过既有会话验证入口使用，开发固定凭据只有在显式启用时才可用。公开 API Key 不能访问后台；详见[身份与会话](../architecture/identity-and-session.md#兼容边界)。

```sh
export HOOX_URL=https://control.example.invalid
hoox validate agent.yaml --remote --token-file /path/to/hoox-access-token
```

## 命令

### validate

```sh
hoox validate agent.yaml
hoox validate agent.yaml --remote --token-file /path/to/hoox-access-token
hoox validate agent.yaml --remote --definition agent_example --expected-generation 3
```

默认完全离线，使用 protocol 的同一 YAML 解析器与结构校验；不要求 URL 或凭据，不读取令牌文件，不检查远程引用。`--remote` 先进行本地校验，再调用后台导入接口的 dry-run，检查当前权限、目标、模型和外部工具引用。默认按新建 Definition 校验；检查已存在的 Definition 时同时提供 `--definition` 与 `--expected-generation`。Tenant 外键的最终确认仍在实际导入事务中完成，不把 dry-run 当成提交承诺。

### push

```sh
hoox push agent.yaml --token-file /path/to/hoox-access-token
hoox push agent.yaml --definition agent_example --expected-generation 3 --json
hoox push agent.yaml --definition agent_example --expected-generation 3 --dry-run
```

不指定 `--definition` 时按 YAML 中的 ID 创建 Definition 及首个草稿；可省略 generation，或显式传 `0`。向已有 Definition 追加草稿时必须同时传目标 ID 和当前 generation；文件 ID 与可用范围必须匹配目标。成功输出 `definitionId`、`revisionId`、`status: draft` 和本次 `idempotencyKey`。**push 不自动发布，也不改变当前已发布 Revision。** `--dry-run` 只校验，不创建草稿。

每次 push 自动生成一个 `Idempotency-Key`。单次命令对网络异常、超时、408、429、500、502、503、504 最多尝试三次，重试复用同一键和同一请求正文；其他 4xx 不重试。网络失败后的最终错误不意味着服务端一定未提交。不同命令调用会生成新键；不确定结果时先在后台核对草稿，再决定是否重新 push，不能把重跑整个命令当成同一幂等请求。

### pull

```sh
hoox pull agent_example
hoox pull agent_example --revision agent_revision_example -o agent.yaml
hoox pull agent_example --revision agent_revision_example --json
```

默认解析该 Definition 的当前已发布 Revision，并导出其精确版本；没有当前发布版本时失败，不隐式选择最新草稿。`--revision` 可显式导出获准读取的指定草稿或历史版本。默认标准输出为后台返回的原始 UTF-8 YAML，不增加换行或重新格式化；`-o` / `--output` 写入相同字节。为避免覆盖本地配置，输出文件必须尚不存在；新文件默认权限为 `0600`（Windows 沿用系统权限）。

## 输出与退出码

所有命令支持 `--json`：成功或失败都只向标准输出写一条 JSON，标准错误为空。普通模式成功写标准输出，失败写标准错误；pull 的普通标准输出只含 YAML。

```json
{"ok":true,"definitionId":"agent_example","revisionId":"agent_revision_example","status":"draft","idempotencyKey":"00000000-0000-4000-8000-000000000000"}
```

```json
{"ok":false,"error":{"kind":"validation","code":"INVALID_CONFIGURATION","message":"Agent 配置文件校验失败","errors":[{"path":"/schemaVersion","code":"UNKNOWN_SCHEMA_VERSION","message":"不支持的配置格式版本"}]}}
```

字段错误使用 JSON Pointer 风格的 `path`。非字段错误的 `errors` 为空数组。远程错误只输出稳定分类与获准的字段错误，不回显响应原文；包含当前凭据的 YAML 响应会被拒绝，不写文件。

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功，包括本地/远程校验通过和 dry-run 通过。 |
| `1` | 命令、参数或 `HOOX_URL` 配置错误。 |
| `2` | YAML/引用校验失败、目标不存在、没有当前发布版本，或 generation/幂等冲突。 |
| `3` | 凭据缺失、无效、过期，或当前身份无权执行操作（401/403）。 |
| `4` | 网络、超时、服务错误、无效响应或拒绝敏感响应。 |
| `5` | 输入或令牌文件不可读、超过限制、不是 UTF-8 普通文件，或输出不可写/已存在。 |

导入和导出审计由既有后台事务负责；本地校验不访问服务端，远程 dry-run 不写导入审计。
