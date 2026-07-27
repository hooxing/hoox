export interface ApiDevelopmentPrincipal {
  readonly userId: string;
  readonly tenantId: string;
}

export type ApiDevelopmentPrincipals = readonly [ApiDevelopmentPrincipal, ApiDevelopmentPrincipal];

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
