import type { CubeGatewayOptions } from "./cube-gateway.js";
import { SandboxRuntimeError } from "./errors.js";

export function cubeConfigFromEnv(
  env: NodeJS.ProcessEnv,
): CubeGatewayOptions & { templateId: string } {
  const apiUrl = env.CUBESANDBOX_API_URL ?? env.CUBE_API_URL;
  const templateId = env.CUBESANDBOX_TEMPLATE_ID ?? env.CUBE_TEMPLATE_ID;
  if (!apiUrl || !templateId) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "缺少 CubeSandbox API URL 或模板 ID");
  }
  const parsed = new URL(apiUrl);
  const proxyPort = parseOptionalInt(env.CUBESANDBOX_PROXY_PORT ?? env.CUBE_PROXY_PORT_HTTP);
  return {
    apiUrl,
    templateId,
    apiKey: env.CUBESANDBOX_API_KEY ?? env.CUBE_API_KEY ?? null,
    // 当前自托管部署的 CubeAPI 与 CubeProxy 同机；未显式配置时从 API URL 安全推导节点 IP。
    proxyNodeIp: env.CUBESANDBOX_PROXY_NODE_IP ?? env.CUBE_PROXY_NODE_IP ?? parsed.hostname,
    ...(proxyPort === undefined ? {} : { proxyPort }),
    proxyScheme: env.CUBESANDBOX_PROXY_SCHEME ?? env.CUBE_PROXY_SCHEME ?? "http",
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeSandbox Proxy 端口非法");
  }
  return parsed;
}
