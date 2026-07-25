# Protocol Mapper 包

该适配包是 Domain 与 Protocol 的唯一连接点。Domain 和 Protocol 彼此不依赖；应用不能自行展开领域实体或绕过 Schema 直接恢复对象。

读取路径固定为：JSON 解析 → TypeBox Schema 校验 → DTO → `rehydrate*` 领域复验。写出路径固定为：不透明领域实体 → 显式 Mapper → DTO。公共错误也在此穷尽映射，领域错误消息永远不会直接返回用户。
