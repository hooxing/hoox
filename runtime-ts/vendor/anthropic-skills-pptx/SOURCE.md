# Anthropic PPTX Skill 来源

本目录仅作为 Hoox 本地开发环境的受限测试 fixture，不构成生产分发授权。除本文件外，目录内容从上游固定提交机械复制，未做修改。

- 上游仓库：`https://github.com/anthropics/skills`
- 上游子目录：`skills/pptx`
- 固定提交：`b29e7cf65e5cb78a5ac33d582270551bc74a14eb`
- 规范包摘要：`8d95d791ec2800a1b6bb0cadeb20f3ae4ffb8b9a42f02552988d7d0efc976067`
- 导入日期：`2026-08-03`
- 上游许可证：Proprietary，完整条款见 `LICENSE.txt`
- 发布范围：仅 `RUNTIME_ENV=development` 的本地 Skill Center 测试目录

## 同步规则

1. 克隆上游并检出上述固定提交，禁止从浮动分支直接发布；
2. 机械复制 `skills/pptx` 全部内容，保留 `LICENSE.txt`；
3. `SOURCE.md` 只记录本仓库来源，不进入运行时 Skill 包；
4. 更新固定提交时必须重新计算规范包摘要、更新测试并新增 ADR；
5. 生产构建、生产启动和公开目录发布不得调用 development publisher。
