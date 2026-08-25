# Protocol 包

该包使用 TypeBox 定义 `v1` DTO、成功/错误信封和事件信封的运行时 Schema，并从 Schema 推导 TypeScript 类型。

Protocol 与 Domain 有意解耦：

- Protocol 负责不可信 JSON 的形状、版本和稳定公开错误码。
- Domain 负责品牌 ID、Tenant 所有权和状态机不变量。
- 应用层必须先校验 Protocol，再显式映射 Domain；禁止直接把 DTO 当作领域对象。

生产输出 Mapper 位于 `@hoox/protocol-mapper`：把 Domain 显式投影为公开 DTO，并集中归一化公共错误。外部 JSON 的 Schema 校验由接收它的协议适配层负责；持久化数据仍直接通过 Domain 的 `rehydrate*` 校验，不经过公开 DTO。

默认对象 Schema 拒绝额外字段。公开错误不包含内部错误、资源 ID 或 Tenant 存在性信息。Schema 库选择与迁移边界见 `docs/decisions/domain-schema-library.md`。
