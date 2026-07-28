export interface ApiDevelopmentPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

export type ApiDevelopmentPrincipals = readonly [ApiDevelopmentPrincipal, ApiDevelopmentPrincipal];

export const DEVELOPMENT_API_DEFAULT_PORT = 3001;
export const DEVELOPMENT_WEB_ORIGIN = "http://127.0.0.1:4173";

/** 固定开发凭据必须证明两个彼此隔离的身份，启动和初始化命令共用这一条约束。 */
export function assertDevelopmentPrincipalsIsolated(principals: ApiDevelopmentPrincipals): void {
  const [first, second] = principals;
  if (first.userId === second.userId || first.tenantId === second.tenantId) {
    throw new Error("DEVELOPMENT_IDENTITIES_MUST_BE_ISOLATED");
  }
}

/**
 * 固定 token 没有真实认证能力，因此只能绑定字面回环地址。
 * 不解析 DNS，也不接受任意解析结果恰为回环的 hostname，避免 hosts/DNS 变化扩大暴露面。
 */
export function normalizeDevelopmentLoopbackHost(host: string): "127.0.0.1" | "::1" {
  if (host === "127.0.0.1" || host === "::1") return host;
  // `localhost` 只作为人类友好的输入，实际监听固定为 IP，绝不把安全边界交给 DNS/hosts。
  if (host.toLowerCase() === "localhost") return "127.0.0.1";
  throw new Error("DEVELOPMENT_API_REQUIRES_LOOPBACK_LISTENER");
}

/** 开发预签名 URL 必须落到独立回环 origin，不能借固定凭据开放跨网访问。 */
export function assertDevelopmentPublicObjectStorageEndpoint(
  value: string,
  apiHost: string,
  apiPort: number,
): void {
  const normalizedApiHost = normalizeDevelopmentLoopbackHost(apiHost);
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN");
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    !/^https?:\/\/(?:127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/iu.test(value) ||
    (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") ||
    (hostname !== "127.0.0.1" && hostname !== "[::1]" && hostname !== "::1") ||
    endpoint.port === "0" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    (endpoint.pathname !== "" && endpoint.pathname !== "/") ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("DEVELOPMENT_S3_PUBLIC_ENDPOINT_REQUIRES_LOOPBACK_ORIGIN");
  }
  const apiOrigin = new URL(
    `http://${normalizedApiHost === "::1" ? "[::1]" : normalizedApiHost}:${apiPort}`,
  ).origin;
  if (endpoint.origin === apiOrigin || endpoint.origin === DEVELOPMENT_WEB_ORIGIN) {
    throw new Error("DEVELOPMENT_S3_PUBLIC_ENDPOINT_MUST_BE_ISOLATED");
  }
}
