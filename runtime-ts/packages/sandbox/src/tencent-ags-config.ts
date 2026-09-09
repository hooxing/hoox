import { e2bConfigFromEnv } from "./e2b-config.js";
import { SandboxRuntimeError } from "./errors.js";
import type { TencentAgsGatewayOptions } from "./tencent-ags-gateway.js";

export function tencentAgsConfigFromEnv(
  env: NodeJS.ProcessEnv,
): TencentAgsGatewayOptions & { readonly templateId: string } {
  for (const key of ["TENCENT_AGS_API_KEY", "TENCENT_AGS_DOMAIN", "TENCENT_AGS_TEMPLATE_ID"]) {
    if (!env[key]?.trim()) throw new SandboxRuntimeError("INVALID_ARGUMENT", `缺少 ${key}`);
  }
  const config = e2bConfigFromEnv({
    E2B_API_KEY: env.TENCENT_AGS_API_KEY,
    E2B_DOMAIN: env.TENCENT_AGS_DOMAIN,
    E2B_TEMPLATE_ID: env.TENCENT_AGS_TEMPLATE_ID,
  });
  return { ...config, domain: config.domain as string };
}
