// 兼容根入口：聚合全部子入口。应用生产代码应从 @hoox/persistence/<子入口> 导入，
// 避免进程加载与自身职责无关的 Repository 与 SDK；见 docs/architecture/persistence-and-database.md。
export * from "./entrypoints/postgres.js";
export * from "./entrypoints/blob.js";
export * from "./entrypoints/admin.js";
export * from "./entrypoints/thread.js";
export * from "./entrypoints/run-execution.js";
export * from "./entrypoints/maintenance.js";
