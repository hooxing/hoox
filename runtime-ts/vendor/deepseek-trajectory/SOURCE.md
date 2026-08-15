# DeepSeek Harness Trajectory 来源

- 上游仓库：`deepseek-ai/deepseek-harness`
- 上游包：`packages/client/ui-trajectory`
- 固定提交：`47f943859bef60e4160492346772ded9b24f765a`
- 上游版本：`0.1.0-rc.5`
- 许可证：MIT，见 `LICENSE`

该目录保存未经业务改写的上游 Trajectory 源码快照，作为内部查看器交互、布局和兼容适配的固定依据。
Cube Runtime 不直接加载 DeepSeek Harness 的 Cordis、Conversation Runtime 或 UI Primitives；实际运行代码通过
`@cube-runtime/trajectory` 把内部无损事件账本适配为相同的 Turn / Input / Model / Tools 视图语义。
