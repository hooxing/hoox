# ADR-0019：Workspace 清单与安全物化计划核心

- 状态：已接受
- 日期：2026-07-26
- 决策者：M2 Workspace 核心实现
- 关联任务/PR：M2 Thread Workspace 不可变内容清单
- 替代关系：细化 ADR-0005、ADR-0010，不替代既有决策

## 背景

WorkspaceRevision 已经是不可变领域对象，但此前只有整体 `objectKey + digest`，尚未定义对象中的文件清单、路径规则或从前一 Revision 恢复工作目录的确定性行为。直接打包目录会把 symlink、特殊文件、平台路径差异和遍历风险带进 Sandbox；只用内容 SHA-256 又无法遵守 ADR-0010 的 incarnation 生命周期。

本切片只建立纯 TypeScript 契约和规划，不创建宿主目录、不读取文件，不连接 PostgreSQL、S3 或 CubeSandbox，也不声明已经完成发布、恢复或生产物化。

## 决策驱动因素

- 任意外部清单都必须在物化前阻止绝对路径、路径穿越和平台歧义；
- 相同逻辑清单需要产生相同 digest 和操作顺序，便于幂等、审计和缓存；
- Workspace 文件引用必须绑定 stable Blob 的不可复用 incarnation 与精确物理键；
- 产品配额尚未定稿，核心不能偷偷固定一组看似合理的数字；
- 物化复用提示不能被误解为租户授权或 Blob 完整性已经通过。

## 备选方案

### 方案 A：tar/zip 作为唯一 Revision 格式

写入和下载简单，但包内路径、symlink 和特殊文件必须依赖解包器防护；单文件差异与复用不可见，整体摘要不能直接绑定每个 Blob incarnation。

### 方案 B：版本化逐文件清单与纯函数物化计划

每个普通文件保存路径、内容摘要/大小和 stable 对象完整身份；canonical digest 覆盖排序后的全部字段；纯函数比较前后清单生成删除、建目录、写文件和保留计划。对象数量增加，但安全边界和差异可单独测试。

### 方案 C：直接扫描 Sandbox 或宿主目录决定差异

能够观察实际目录，却使规划结果依赖外部状态和平台行为，难以确定性重试，也会让本核心包获得不必要的宿主文件权限。

## 选择

采用方案 B，并固定 schemaVersion 1：

- 首版 entry 只允许 `type: file` 的普通文件；directory 由路径前缀推导，symlink、hardlink、socket、FIFO、device 与其他特殊类型全部拒绝。未来支持任何新类型必须提升 schemaVersion 并单独审查；
- 路径必须是非空、已是 Unicode NFC 的 POSIX 相对路径；拒绝未配对 surrogate、C0/C1 与 Unicode `Cf` 格式控制字符、`/` 绝对路径、Windows 盘符/ADS、反斜杠、Windows 非法字符 `< > : " | ? *`、保留设备名（忽略 ASCII 大小写且含扩展名）、尾点/尾空格、空段、`.` 和 `..`。核心不做静默 Unicode 或 Windows 路径转换；
- schemaVersion 1 的大小写碰撞键精确定义为“只把 ASCII `A-Z` 映射到 `a-z`，其他 NFC code point 原样保留”。它拒绝精确重复、ASCII 大小写碰撞及双向目录/文件前缀冲突，但不宣称实现完整 Unicode case folding；Sandbox 目标仍是大小写敏感 POSIX。未来若扩大折叠表必须提升 schemaVersion，不能依赖会随 Node.js 变化的 Unicode 数据表；
- canonical payload 使用固定字段顺序、JSON 字符串转义、非负且非 `-0` 的十进制安全整数，entry 按合法 Unicode 路径的 UTF-8 字节序排列，再对 UTF-8 bytes 计算小写 SHA-256。拒绝未配对 surrogate 后，UTF-8 comparator 对允许路径构成全序；清单自身的 `digest` 不进入摘要，并以固定 Unicode golden vector 防止实现漂移；
- 清单根绑定 `tenantId` 并纳入 canonical digest；解析时必须与调用方可信 Tenant 一致，所有 entry 也必须属于该 Tenant。每个 entry 同时绑定 `sha256 + size` 与 `tenantId + purpose=workspace + incarnationId + physicalObjectKey`。物理键必须与 ADR-0010 stable key 后缀逐字段一致；同 `(tenantId, purpose, incarnationId)` 在一个清单中只能绑定相同 `sha256 + size + physicalObjectKey`，同 SHA-256 仍不代表同物理对象；
- 所有 unknown 对象和数组先通过 data descriptor 单次快照；accessor、稀疏数组、额外数组字段、Symbol 字段和非普通对象失败关闭。后续校验与组装只读取快照，Proxy 的普通 `get` 不能在校验后替换字段；
- 调用方每次创建/解析清单必须显式提供 `maxFiles`、`maxTotalBytes`，可选提供单文件和路径 UTF-8 字节限制。核心不提供产品默认值；
- 物化计划只接受完整性通过的不可变清单和规范 POSIX 绝对根目录。输出路径均由安全相对路径解析得到；计划可从空目录或前一清单生成，目录创建按浅到深、删除按深到浅、文件按 UTF-8 字节序；
- 相同路径且 `sha256 + size` 相同可作为保留候选，即使目标清单已切换到另一个合法 incarnation；跨路径复用不在 schemaVersion 1 计划中提供，避免来源在删除后失效。计划编码固定阶段 `verify_existing → remove_files → remove_directories → ensure_directories → materialize_files`，执行器不得在验证候选前删除来源；目标清单的每个文件始终保留 fallback stable 对象身份，候选授权或实际内容校验失败时必须写入 fallback。

## 理由

逐文件清单让路径安全、内容完整性和 Blob 生命周期成为可验证数据，而不是解包时的隐含约定。严格拒绝而非转换能避免同一输入在 Windows、Linux 和 Sandbox 中映射到不同文件。纯计划保留了未来执行器选择批量下载、Sandbox 内复制或重建的空间，同时不把尚未实现的授权、HEAD/GET 验证包装成完成状态。

## 影响

### 正面影响

- 清单顺序不影响 Revision digest，单字节、路径或 incarnation 变化都会被发现；
- 物化计划可脱离 PG、S3 和 CubeSandbox 做属性及边界测试；
- 目录/文件冲突和目标逃逸在任何远端副作用前失败关闭；
- 配额可以按部署、租户等级或后续产品证据配置。

### 负面影响与成本

- 大量文件的清单需要完整排序与摘要，极大清单未来可能需要流式 canonical 编码；
- 大小写碰撞规则比 Linux 原生文件系统严格，部分现有目录不能直接导入；
- stable 对象切换 incarnation 但内容相同时可以保留工作副本字节，执行器仍需把目标 Revision 元数据提交为新身份。

### 安全、数据与运维影响

- `tenantId` 和物理键只属于引用身份，不能替代当前可信 Tenant Context、RLS 或下载授权；
- `reuseCandidate` 不是执行许可，执行器必须证明候选来源属于可访问的前一 Workspace 并重新校验内容；
- 本核心从不调用宿主文件系统。未来执行器必须继续禁止跟随 symlink，并在每个远端写入前使用计划中的绝对 POSIX 目标；
- schemaVersion 1 一旦用于生产 Revision，canonical 算法、大小写碰撞键或字段意义不能原地修改。

## 验证

- 排列属性测试证明 entry 顺序不改变 digest；单字节、路径和 incarnation 改变会改变 digest；
- Unicode NFC/未配对 surrogate/C1/Cf、明确的 ASCII case-fold、重复路径、双向目录/文件前缀、绝对路径、Windows 保留名/非法字符/盘符/ADS、反斜杠、NUL 与 `.`/`..` 对抗测试失败关闭；
- symlink、目录与特殊文件 entry 被 schemaVersion 1 拒绝；
- 文件数、总字节、单文件和 UTF-8 路径限制均由测试传入不同策略验证；
- 空目录与前一清单的物化计划逐字段确定，验证必须先于删除，目录替换顺序和 stable fallback 可断言；
- 包级 test、typecheck、build、根 `check:clean-vendor` 与 `git diff --check` 通过。

## 可逆性与回退

生产 Revision 写入前，可以删除本包或调整 schemaVersion 1。生产数据引用该格式后，只能新增 schemaVersion 和显式转换器；不得重解释旧 canonical bytes，否则已有 digest 会失效。纯规划算法可以在不改变 manifest 的前提下新增执行优化，但路径和授权不变量不能放宽。

## 后续工作

- 设计 PostgreSQL Manifest/Revision 引用事务与 stable Blob 引用守卫；
- 实现由授权事实源驱动的 S3/CubeSandbox 物化执行器，并对每个下载做大小与 SHA-256 校验；
- 实现 Sandbox 工作副本扫描、普通文件上传、Revision CAS 以及失败恢复；
- 用真实规模数据确定产品默认配额和流式清单阈值。

## 实施记录

- `@cube-runtime/workspace` 已实现 schemaVersion 1 契约、canonical digest、路径边界和纯物化差异计划；不包含任何外部 I/O。
