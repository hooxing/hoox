import { normalizeDevelopmentLoopbackHost } from "@hoox/process-runtime";

export { normalizeDevelopmentLoopbackHost };
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

/**
 * 公开 Demo 仅允许通过宿主机反向代理暴露：API 自身仍绑定字面回环地址，
 * 身份入口只接受显式 HTTPS origin，对象交付也必须使用 HTTPS。
 */
export function assertDemoPublicAccessConfiguration(input: {
  readonly listenHost: string;
  readonly publicOrigin: string | undefined;
  readonly publicObjectStorageEndpoint: string;
  readonly trustedOrigins: readonly string[];
}): void {
  normalizeDevelopmentLoopbackHost(input.listenHost);
  if (input.publicOrigin === undefined || input.trustedOrigins.length === 0) {
    throw new Error("DEMO_PUBLIC_ACCESS_REQUIRES_PUBLIC_ORIGIN");
  }
  let publicOrigin: URL;
  try {
    publicOrigin = new URL(input.publicOrigin);
  } catch {
    throw new Error("DEMO_PUBLIC_ACCESS_REQUIRES_HTTPS_ORIGIN");
  }
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.username !== "" ||
    publicOrigin.password !== "" ||
    publicOrigin.pathname !== "/" ||
    publicOrigin.search !== "" ||
    publicOrigin.hash !== "" ||
    publicOrigin.origin !== input.publicOrigin
  ) {
    throw new Error("DEMO_PUBLIC_ACCESS_REQUIRES_HTTPS_ORIGIN");
  }
  for (const origin of input.trustedOrigins) {
    const parsed = new URL(origin);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      throw new Error("DEMO_PUBLIC_ACCESS_REQUIRES_HTTPS_ORIGINS");
    }
  }
  if (!input.trustedOrigins.includes(publicOrigin.origin)) {
    throw new Error("DEMO_PUBLIC_ORIGIN_MUST_BE_TRUSTED");
  }
  const publicEndpoint = new URL(input.publicObjectStorageEndpoint);
  if (
    publicEndpoint.protocol !== "https:" ||
    publicEndpoint.username !== "" ||
    publicEndpoint.password !== "" ||
    publicEndpoint.search !== "" ||
    publicEndpoint.hash !== ""
  ) {
    throw new Error("DEMO_PUBLIC_S3_ENDPOINT_REQUIRES_HTTPS");
  }
}
