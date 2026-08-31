# ADR-20260831092112：Vendor Tree 摘要跨平台规范化换行

- 状态：已接受
- 日期：2026-08-31
- 决策者：Runtime 团队
- 关联决策：ADR-20260827174210

## 背景

生产供应链 Gate 使用 vendor 目录中文件的相对路径和原始字节生成 canonical tree SHA-256。Windows 工作树可能保留 CRLF，而 GitHub Actions 的 Linux checkout 使用 LF；同一 Git blob 因工作树换行不同得到不同摘要，导致本地 Gate 通过但 CI 失败，阻断后续 Demo CD。

## 决策

1. canonical vendor tree 在哈希前识别可无损 UTF-8 解码的文本文件，并把 CRLF 或 CR 统一为 LF。
2. 无法无损 UTF-8 往返的二进制文件继续按原始字节计算，不改变 tokenizer 等二进制或非文本资源的完整性边界。
3. 文件相对路径、规范化后的字节长度和内容仍共同进入摘要；新增测试证明 LF 与 CRLF 等价，而实际文本变化仍会改变摘要。
4. 重新生成许可证策略中的 DeepSeek V4 tokenizer source tree 摘要和三个 production SBOM。

## 备选方案

### 直接登记 Linux checkout 的摘要

拒绝。这样会让 Windows 本地检查继续失败，并把同一 Git 内容错误地解释为不同供应链树。

### 完全忽略文本文件内容

拒绝。许可证、来源记录和 package manifest 都属于受控供应链证据，必须继续参与摘要。

## 影响

- 同一受控文本在 Windows 与 Linux 上使用不同工作树换行时生成相同摘要。
- 文本字符、路径、文件增删以及二进制内容变化仍会失败关闭。
- CI 可以在不放宽 vendor 完整性校验的前提下继续进入容器 Gate 与 Demo CD。

## 验证

- `corepack pnpm exec vitest run tests/production-supply-chain.test.ts`
- `corepack pnpm supply-chain:check`
- 在 Git archive 提取树和 Windows 工作树上分别计算 tokenizer vendor 摘要并确认一致。

## 可逆性

可以恢复原始字节哈希，但会重新引入跨平台漂移。在回退前必须先把所有受控 vendor 文本强制为相同工作树换行，并在 Windows、Linux 两个平台验证。
