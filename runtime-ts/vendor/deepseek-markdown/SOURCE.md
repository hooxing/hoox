# DeepSeek 增量 Markdown 解析器来源

- 上游：`https://github.com/deepseek-ai/deepseek-harness`
- 固定提交：`76fda729799fe9b3848dbe2c211d4b231032b81e`
- 原始文件：`packages/client/ui-primitives/src/markdown/incremental.ts`
- 许可证：MIT，见 `LICENSE`。

`src/incremental.ts` 保留上游解析器逻辑，仅规范文件末尾换行。该包不引入 Cordis、会话运行时、UI 组件或高亮器。Hoox 的 Markdown 语法、安全策略、全局引用处理和渲染由 Web 拥有；升级时须运行 Web 的增量解析与安全回归测试。
