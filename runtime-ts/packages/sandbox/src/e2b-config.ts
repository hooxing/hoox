import type { E2BGatewayOptions } from "./e2b-gateway.js";
import { SandboxRuntimeError } from "./errors.js";
import { validateTemplateId } from "./validation.js";

export function e2bConfigFromEnv(
  env: NodeJS.ProcessEnv,
): E2BGatewayOptions & { readonly templateId: string } {
  const apiKey = normalizedRequiredText(env.E2B_API_KEY, "缺少 E2B API Key");
  const templateId = normalizedRequiredText(env.E2B_TEMPLATE_ID, "缺少 E2B Template ID");
  validateTemplateId(templateId);
  const domain = normalizedOptionalText(env.E2B_DOMAIN);
  return {
    apiKey,
    templateId,
    ...(domain === undefined ? {} : { domain }),
  };
}

function normalizedRequiredText(value: string | undefined, message: string): string {
  const normalized = normalizedOptionalText(value);
  if (normalized === undefined) throw new SandboxRuntimeError("INVALID_ARGUMENT", message);
  return normalized;
}

function normalizedOptionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
