# ADR-0073：数值游标文本投影后的数据库排序边界

- 状态：已接受
- 日期：2026-08-01
- 关联：ADR-0063、ADR-0064、ADR-0068、ADR-0069
- 范围：PostgreSQL bigint 游标读取、Thread Context 重建、Follow-up/Steer、waiting 恢复、Sandbox generation

## 背景

Runtime 为避免 JavaScript 超出安全整数边界，在 PostgreSQL 查询结果中把 bigint 游标投影为
`sequence::text`，再由 TypeScript 做安全整数校验。部分查询同时写成 `ORDER BY sequence`。PostgreSQL
在 `ORDER BY` 中优先解析同名输出列，因此这里排序的是 text 投影而不是底表 bigint：第 10 条之后会得到
`1,10,11,2...9`。

该问题在一个包含三轮工具调用的 Run 中出现：Thread Context 已连续写入 1 至 11，但活动历史重建把文本
排序后的最后一行读成 9，误报 `legacy_gap`，Pi 安全点随后以 `PROTOCOL` 失败。相同写法还存在于输入回执、
waiting rollout、compaction window 和 Sandbox generation 查询中。

## 备选

1. 不再把 bigint 转为 text，直接依赖 PostgreSQL 驱动的 bigint 解析。会重新引入精度风险，不采用。
2. 在 TypeScript 中对结果重新做数值排序。可以修复当前读取，但数据库的 `LIMIT`、`FOR UPDATE` 和分页会
   在应用层排序前已经选错记录，不采用。
3. 保留 text 传输投影，但所有排序、游标比较、`LIMIT` 和锁定顺序都显式引用底表数值列。选择此方案。

## 选择

1. `SELECT bigint_column::text` 只影响传输形状；`ORDER BY` 必须使用带表名或表别名的 bigint 原列，例如
   `ORDER BY thread_context_entries.sequence`。
2. 该约束覆盖升序、降序、分页、`LIMIT 1` 和 `FOR UPDATE`，不能依赖未限定的同名输出别名。
3. 修复 Thread Context、compaction window、Thread input、Follow-up/Steer、waiting rollout 和 Thread
   Sandbox generation 中发现的同类查询，不修改表结构和已存数据。

## 影响

- 超过 9 条事实的 Thread Context 可以继续重建，不再伪造 `legacy_gap` 或让模型循环以 `PROTOCOL` 失败。
- 超过 9 条的回执事件、输入序列、rollout sequence、compaction window 与 Sandbox generation 保持真正
  的数值顺序。
- 数据格式、API 字段和迁移版本均不变化；修复可以直接部署，历史数据无需回填。

## 验证

- PostgreSQL 集成测试构造 14 条 Thread Context 事实，验证重启重建返回 `ready` 且 digest 稳定。
- 源码约束测试覆盖全部已知的 bigint text 投影查询，要求排序显式引用底表数值列。
- 使用真实 docx 多工具任务验证第 10 条之后仍能继续调用模型、生成并交付文件。

## 可逆性

改动只修正查询排序解析，回退代码不会破坏数据，但会重新暴露十位数游标故障，因此不应回退。若后续统一
采用自定义 PostgreSQL bigint codec，必须先证明 JavaScript 安全整数边界和所有公开协议不受影响，再用新
ADR 替代本决策。
