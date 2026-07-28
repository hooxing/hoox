import type { CubeGatewayOptions } from "./cube-gateway.js";
import { SandboxRuntimeError } from "./errors.js";
import { validateBaseUrl, validateTemplateId } from "./validation.js";

export function cubeConfigFromEnv(
  env: NodeJS.ProcessEnv,
): CubeGatewayOptions & { templateId: string } {
  const apiUrl = env.CUBESANDBOX_API_URL ?? env.CUBE_API_URL;
  const templateId = env.CUBESANDBOX_TEMPLATE_ID ?? env.CUBE_TEMPLATE_ID;
  if (!apiUrl || !templateId) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "缺少 CubeSandbox API URL 或模板 ID");
  }
  const normalizedApiUrl = validateBaseUrl(apiUrl);
  validateTemplateId(templateId);
  const proxyNodeIp = env.CUBESANDBOX_PROXY_NODE_IP ?? env.CUBE_PROXY_NODE_IP;
  const proxyPort = parseOptionalInt(env.CUBESANDBOX_PROXY_PORT ?? env.CUBE_PROXY_PORT_HTTP);
  const proxyScheme = env.CUBESANDBOX_PROXY_SCHEME ?? env.CUBE_PROXY_SCHEME;
  const proxyRouting = resolveCubeProxyRouting({
    apiUrl: normalizedApiUrl,
    ...(proxyNodeIp === undefined ? {} : { proxyNodeIp }),
    ...(proxyPort === undefined ? {} : { proxyPort }),
    ...(proxyScheme === undefined ? {} : { proxyScheme }),
  });
  return {
    apiUrl: normalizedApiUrl,
    templateId,
    apiKey: env.CUBESANDBOX_API_KEY ?? env.CUBE_API_KEY ?? null,
    ...proxyRouting,
  };
}

/**
 * CubeAPI 是管理面，Sandbox command/filesystem 是经虚拟域名访问的 CubeProxy 数据面。
 * 当前自托管部署二者同机；未显式配置时必须从 API URL 推导直连节点，否则 Node 会尝试
 * 解析 `*.cube.app`，表现为 create 成功而所有工具 RPC 失败。
 */
export function resolveCubeProxyRouting(input: {
  readonly apiUrl: string;
  readonly proxyNodeIp?: string;
  readonly proxyPort?: number;
  readonly proxyScheme?: string;
}): {
  readonly proxyNodeIp: string;
  readonly proxyPort?: number;
  readonly proxyScheme: "http" | "https";
} {
  const normalizedApiUrl = validateBaseUrl(input.apiUrl);
  const proxyNodeIp = input.proxyNodeIp ?? new URL(normalizedApiUrl).hostname;
  const proxyScheme = input.proxyScheme ?? "http";
  if (!proxyNodeIp.trim()) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeSandbox Proxy 节点地址不能为空");
  }
  if (
    input.proxyPort !== undefined &&
    (!Number.isInteger(input.proxyPort) || input.proxyPort < 1 || input.proxyPort > 65_535)
  ) {
    throw new SandboxRuntimeError("INVALID_ARGUMENT", "CubeSandbox Proxy 端口非法");
  }
  if (proxyScheme !== "http" && proxyScheme !== "https") {
    throw new SandboxRuntimeError(
      "INVALID_ARGUMENT",
      "CubeSandbox Proxy scheme 只能是 http 或 https",
    );
  }
  return {
    proxyNodeIp,
    ...(input.proxyPort === undefined ? {} : { proxyPort: input.proxyPort }),
    proxyScheme,
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
