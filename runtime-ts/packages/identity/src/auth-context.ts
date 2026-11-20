import type { ApiKeyScope, TenantId, UserId } from "@hoox/domain";
import type { AuthPrincipalKind } from "./api-key.js";

export interface AuthPrincipal {
  readonly userId: UserId;
  readonly kind?: AuthPrincipalKind;
  /**
   * 固定开发 fixture 与服务凭据携带已绑定的 tenant；生产 JWT 只有受验签保护的 sub。
   * 业务 TenantScope 仍需由 PostgreSQL Membership/RLS 二次授权后构造。
   */
  readonly tenantId?: TenantId;
  readonly apiKey?: Readonly<{ readonly id: string; readonly scopes: readonly ApiKeyScope[] }>;
}

/**
 * 生产身份供应商的适配入口。实现必须先验证凭据，再返回可信 principal；
 * 不能从 x-tenant-id 等普通客户端 Header 直接构造租户身份。
 */
export interface AuthContextResolver {
  resolve(input: {
    readonly authorization: string | undefined;
    readonly requestId: string;
  }): Promise<AuthPrincipal | undefined>;
}
