# ADR-0099：Skill 恢复查询的 PostgreSQL 稳定排序

- 状态：已接受
- 日期：2026-08-04
- 决策者：Runtime 维护者
- 关联任务/PR：安装 Skill 后 Run 领取即进入恢复状态故障修复
- 替代关系：细化 ADR-0095 的 Skill Session 恢复路径

## 背景

Worker 创建每个 Pi Session 时都会恢复当前 Run 已持久化的 Skill 调用。恢复仓储使用
`SELECT DISTINCT invocation_name ... ORDER BY invocation_name COLLATE "C"` 去重并稳定排序；PostgreSQL
要求 `SELECT DISTINCT` 的排序表达式必须出现在选择列表中，因此该查询在包括空调用集合在内的所有
路径都会以 SQLSTATE `42P10` 失败。Run 已被领取，模型尚未启动，最终只能在 `claimed` 阶段进入
`recovery_required`。

## 决策驱动因素

- Session 创建必须在没有历史 Skill 调用时正常返回空集合；
- 同一调用名跨 Attempt 只能恢复一次，仍需数据库侧去重；
- 排序必须使用 PostgreSQL `C` collation，避免部署环境区域设置改变 Prompt 顺序；
- 回归验证必须执行真实 PostgreSQL 解析和查询，不能只检查 SQL 字符串。

## 备选方案

### 方案 A：使用 `GROUP BY invocation_name` 去重，再按 `COLLATE "C"` 排序

保留原有结果语义，排序表达式不受 `SELECT DISTINCT` 的选择列表限制。

### 方案 B：把 collated 表达式加入 `SELECT DISTINCT` 列表

可以满足 PostgreSQL 语法，但会把数据库表达式细节带入结果列定义，别名与排序解析更容易再次产生
方言差异。

### 方案 C：查询全部行后在 TypeScript 中去重和排序

规避 SQL 限制，但会读取重复数据，并复制数据库 `C` collation 的排序语义。

## 选择

采用方案 A。查询以 `GROUP BY invocation_name` 保持唯一名称，并继续使用
`ORDER BY invocation_name COLLATE "C"` 生成稳定顺序。

## 理由

该方案修改面最小，结果集合与原设计一致，并让唯一性和排序继续在数据库内完成。方案 B 的列投影更
脆弱；方案 C 会扩大读取和跨运行时排序一致性的风险。

## 影响

- 安装 Skill 后，Worker 可在 Session 创建阶段正常读取空或非空的历史调用集合；
- 不修改表结构、既有 Skill 快照或调用事实；
- 已经进入 `recovery_required` 的 Attempt 不会被普通 Worker 自动重放，需结束旧 Run 后重新提交；
- PostgreSQL Run Worker 集成测试增加真实 claim 栅栏下的空集合恢复用例。

## 验证

- 集成测试通过真实 PostgreSQL 调用 `PgSkillRuntimeRepository.listLoadedPackages`，断言空集合返回；
- 本地重建并重启 Worker，创建安装了 PPTX Skill 的新 Run，确认其越过 `claimed` 并完成模型调用；
- Worker 进程保持存活，队列不再积压。

## 可逆性与回退

该修改不涉及迁移，可直接回退代码；但回退会恢复 `42P10`，使所有经过 Skill 恢复入口的 Run 再次在
模型调用前停止。

## 实施记录

- 2026-08-04：将 `DISTINCT` 改为 `GROUP BY`，增加真实 PostgreSQL 回归测试。
