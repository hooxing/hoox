import { SandboxRuntimeError, assertPositiveInteger } from "./errors.js";

export function validateBaseUrl(value: string | undefined): string {
  if (typeof value !== "string" || !value.trim()) invalid("CubeSandbox API URL 不能为空");
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeSandbox API URL 非法", error);
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || url.username || url.password) {
    invalid("CubeSandbox API URL 必须是无内嵌凭证的 HTTP(S) URL");
  }
  return url.toString().replace(/\/$/, "");
}

export function validateTemplateId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    invalid("templateId 不能为空或包含 NUL");
  }
}

export function validateSandboxId(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    invalid("Sandbox ID 不能为空或包含 NUL");
  }
}

export function validateTtl(value: number | undefined, max: number): number {
  const ttl = value ?? max;
  assertPositiveInteger(ttl, "Sandbox TTL");
  if (ttl > max) invalid(`Sandbox TTL 不能超过 ${max} 秒`);
  return ttl;
}

export function validateEnvironment(env: Record<string, string> | undefined): void {
  if (!env) return;
  if (typeof env !== "object" || Array.isArray(env)) invalid("Sandbox 环境变量必须是对象");
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) invalid(`Sandbox 环境变量名非法：${key}`);
    if (typeof value !== "string" || !value || value.includes("\0")) {
      invalid(`Sandbox 环境变量 ${key} 的值不能为空或包含 NUL`);
    }
  }
}

export function validateText(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    invalid(`${label}不能为空或包含 NUL`);
  }
}

export function validateAbsolutePath(path: string): void {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.includes("\0") ||
    path.split("/").includes("..")
  ) {
    invalid("Sandbox 文件路径必须是无上跳片段的 Linux 绝对路径");
  }
}

export function validateTimeout(value: number | undefined, label = "timeoutMs"): void {
  assertPositiveInteger(value, label);
}

function invalid(message: string): never {
  throw new SandboxRuntimeError("INVALID_ARGUMENT", message);
}
