# Hoox 项目改名与恢复手册

## 目的

本文记录 Hoox 从早期仓库名和 AISay 技术身份迁移后的关键路径、外部状态、恢复方法和多机同步边界。它是运维恢复记录，不是要求继续使用旧品牌的当前产品文档。

## 身份对照

| 类型 | 旧值 | 当前值 | 恢复说明 |
|---|---|---|---|
| 最早项目名 | CubeSandbox Agent Runtime | Hoox | 仅历史记录保留旧名 |
| 短期技术名 | AISay Runtime | Hoox | 当前代码不再使用旧技术名 |
| 本机仓库目录 | `D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime` | `D:\hopesoft-hooxing\project\agent runtime\hoox` | 过渡期可建立旧路径 Junction |
| 根 npm 包 | `aisay-runtime` | `hoox` | 不提供兼容包 |
| 第一方包 scope | `@aisay/*` | `@hoox/*` | 必须整仓同步 |
| GitHub 远端 | `https://github.com/hooxing/cubesandbox-agent-runtime.git` | 计划迁移到 `https://github.com/hooxing/hoox.git` | GitHub 仓库改名完成前保留旧 URL |
| 计划公开入口 | `hoox.aisay.cc` | 暂时保留 | 域名迁移需单独决策 |

## 不随品牌修改的标识

以下值表达第三方 Provider 或已经形成的持久语义，恢复时不得机械替换：

- `CubeSandbox`、`@cubesandbox/sdk`、`CUBESANDBOX_*`；
- `runtime-ts/vendor/cubesandbox-sdk`、`deploy/cubesandbox`；
- PostgreSQL migration advisory lock `cube_runtime_schema_migrations_v1`；
- 已发布 Skill 主键 `skill_cube_csv_to_pdf`；
- 历史 ADR 中记录的旧项目名称；
- 已经写入外部系统的旧 Mem0 source、旧 JWT 和旧 SBOM。

## 本机目录迁移

执行目录迁移前必须：

1. 提交或明确保存仓库中的全部工作；
2. 停止开发服务、Docker Compose 调用、IDE、终端和占用仓库的 Codex 任务；
3. 从父目录执行命令，不能把当前 PowerShell 工作目录留在待改名目录中；
4. 确认目标目录 `hoox` 不存在。

改名命令：

```powershell
Rename-Item `
  -LiteralPath 'D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime' `
  -NewName 'hoox'
```

为历史 Codex 任务和本地快捷方式建立临时兼容 Junction：

```powershell
New-Item `
  -ItemType Junction `
  -Path 'D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime' `
  -Target 'D:\hopesoft-hooxing\project\agent runtime\hoox'
```

验证：

```powershell
Get-Item 'D:\hopesoft-hooxing\project\agent runtime\hoox'
Get-Item 'D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime' |
  Format-List FullName,LinkType,Target
git -C 'D:\hopesoft-hooxing\project\agent runtime\hoox' status --short --branch
```

只把新路径 `hoox` 作为正式项目打开。旧路径只用于历史兼容，不要在 Codex 或 IDE 中把两个路径注册成两个独立项目。

## 目录回退

如果改名后开发工具无法工作：

1. 关闭所有使用新旧路径的进程；
2. 确认旧路径是 Junction，而不是真实目录；
3. 删除 Junction；
4. 把真实目录改回旧名称。

```powershell
Remove-Item -LiteralPath 'D:\hopesoft-hooxing\project\agent runtime\cubesandbox-agent-runtime'
Rename-Item `
  -LiteralPath 'D:\hopesoft-hooxing\project\agent runtime\hoox' `
  -NewName 'cubesandbox-agent-runtime'
```

执行 `Remove-Item` 前必须通过 `Get-Item` 确认 `LinkType` 为 `Junction`。不得对未经确认的计算路径执行递归删除。

## Codex 对话和任务恢复

本机 Codex 数据位于用户目录，例如：

```text
C:\Users\<用户名>\.codex\sessions
C:\Users\<用户名>\.codex\sqlite
C:\Users\<用户名>\.codex\.codex-global-state.json
```

仓库改名不会主动删除这些文件，但历史任务可能保存旧的绝对 `cwd`。推荐处理顺序：

1. 保留旧路径 Junction；
2. 用新路径打开 Hoox，并为改名后的工作创建新任务；
3. 需要查看旧任务时让 Junction 继续解析旧路径；
4. 历史任务不再需要后再删除 Junction。

不得为了改路径直接编辑 Codex SQLite、JSONL Session 或全局状态文件，也不得在 Codex 运行时通过网盘同步整个 `.codex` 目录。

## 父目录 AGENTS.md

本机父目录约束文件为：

```text
D:\hopesoft-hooxing\project\agent runtime\AGENTS.md
```

其中主仓库路径必须与当前真实目录一致：

```text
D:\hopesoft-hooxing\project\agent runtime\hoox
```

如果恢复为旧目录，也必须同步恢复该文件中的路径，否则 Codex 会操作错误仓库。

## GitHub 远端迁移

GitHub 仓库完成改名后，每台电脑分别执行：

```powershell
git -C 'D:\hopesoft-hooxing\project\agent runtime\hoox' remote set-url origin https://github.com/hooxing/hoox.git
git -C 'D:\hopesoft-hooxing\project\agent runtime\hoox' remote -v
```

Git remote 位于每个 clone 自己的 `.git/config`，不会通过普通 Git 提交同步。远端仓库尚未创建或改名时，不执行上述命令。

## 第二台电脑同步

代码身份修改通过 Git 提交同步，但另一台电脑的外层目录名、Codex 对话、IDE 配置和 remote URL 不会随 `git pull` 自动变化。

推荐步骤：

1. 在第二台电脑提交或保存本地工作；
2. 拉取包含 Hoox 改名的提交；
3. 关闭 Codex、IDE 和终端；
4. 手动把本地仓库目录改为 `hoox`；
5. 更新该电脑父目录的 `AGENTS.md`；
6. GitHub 仓库改名完成后更新该 clone 的 remote；
7. 用新目录建立新的 Codex 任务。

## Compose 和数据恢复

Compose 项目名与卷名迁移到 Hoox 后，Docker 会创建新的资源。旧 MinIO 数据不会自动进入新卷。

发生数据缺失时先列出卷，不立即删除：

```powershell
docker volume ls
docker compose -f docker-compose.dev.yml --env-file .env config
```

需要回退时，可以临时恢复旧 Compose 项目名/卷名后重新启动，或使用经过审阅的数据复制流程迁移。禁止把删除旧卷作为改名步骤的一部分。

## JWT、Mem0 和 Skill 兼容

- 旧 JWT audience 在切换后不再被新配置接受，回退需要签发方与验证方一起恢复；
- Mem0 中旧 `source=aisay-runtime` 与新 `source=hoox` 可以共存，不改写历史记录；
- 已发布 Skill 版本不可原地改品牌，Hoox 元数据使用新的不可变版本；
- 历史 SBOM 保留原制品身份，新构建生成 Hoox 属性命名空间。

## 最小故障检查

```powershell
Test-Path 'D:\hopesoft-hooxing\project\agent runtime\hoox\.git'
git -C 'D:\hopesoft-hooxing\project\agent runtime\hoox' status --short --branch
git -C 'D:\hopesoft-hooxing\project\agent runtime\hoox' remote -v
Select-String `
  -Path 'D:\hopesoft-hooxing\project\agent runtime\AGENTS.md' `
  -Pattern '主仓库固定为'
```

代码层验证按仓库 `AGENTS.md` 执行；品牌迁移至少运行项目身份测试、Prompt 测试、配置检查和供应链检查。
