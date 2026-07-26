// Scheduler 仅触发可重试的后台工作，不承载领域状态。
export const serviceName = "scheduler" as const;

export * from "./process-entry.js";
