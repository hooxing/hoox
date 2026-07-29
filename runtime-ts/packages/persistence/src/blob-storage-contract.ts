/**
 * Worker 写侧、数据库 physicalObjectKey 与 API 读侧必须共用同一前缀。
 * 这是持久数据契约；修改它需要显式迁移，不能作为部署配置临时覆盖。
 */
export const RUNTIME_BLOB_OBJECT_PREFIX = "agent-worker" as const;
