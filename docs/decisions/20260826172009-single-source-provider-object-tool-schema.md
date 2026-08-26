# ADR-20260826172009：Provider 工具 Schema 使用单一严格真源

- 状态：已接受
- 日期：2026-08-26
- 决策者：项目维护者
- 关联任务/PR：收敛 `automation_update` 的重复参数定义
- 替代关系：替代 ADR-20260826164658 的双层 Schema 实现；顶层 object 兼容要求继续有效

## 背景

ADR-20260826164658 为满足 OpenAI-compatible Provider 的顶层 `type: "object"` 要求，引入宽松的 Provider Schema，原严格联合 Schema 则继续负责 Runtime 校验。两份定义重复维护 action、字段和范围，并需要类型断言连接。进一步验证确认 TypeBox 联合 Schema 可以直接附加顶层 `type: "object"`，且目标 DeepSeek Provider 接受这一标准 JSON Schema 组合。

## 备选方案

### 方案 A：保留双层 Schema

已经可用，但字段变化必须同步两份定义，模型侧看到的约束也比 Runtime 宽松。

### 方案 B：在 Provider 适配器中统一改写所有 Schema

可以集中兼容，但会新增全局转换规则；当前只有一个已证明的问题工具，没有足够消费者支撑该抽象。

### 方案 C：在严格联合 Schema 上声明顶层 object

TypeBox 的 `Type.Union` 接受 Schema options。直接添加 `type: "object"` 后，模型请求与 Runtime 校验可以复用同一个定义。

## 选择

选择方案 C。删除宽松 Provider Schema、公开导出和执行期类型断言。`AutomationUpdateToolArgumentsSchema` 同时作为 Provider 参数契约、Runtime 参数类型和严格校验真源。

## 影响

- Provider 继续收到顶层为 object 的 Schema，并能看到每个 action 的准确必填字段；
- Runtime 继续拒绝缺失字段、多余字段和越界值；
- 不改变工具名称、执行权限、失败回执、持久化数据或外部 API；
- 不引入全局 Schema 转换层。

## 验证

- 单元测试同时断言顶层 object 和 action 严格校验；
- pi-adapter、agent-worker 与 Provider 探针相关测试通过；
- 使用当前 DeepSeek 配置发送带严格联合 Schema 的真实请求并确认 HTTP 200。

## 可逆性与回退

该改动不写入数据。若目标 Provider 后续拒绝顶层 object 与 `anyOf` 组合，可恢复独立 Provider Schema；恢复前必须补充对应真实 Provider 证据，避免重新引入无消费者的镜像定义。
