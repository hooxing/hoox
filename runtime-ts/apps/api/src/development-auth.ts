import type { TenantId } from "@cube-runtime/domain";
import type { RuntimeEnvironment } from "@cube-runtime/process-runtime";
import type { AuthContextResolver, AuthPrincipal } from "./ports.js";

type DevelopmentAuthPrincipal = AuthPrincipal & Readonly<{ readonly tenantId: TenantId }>;

/**
 * 仅供开发/测试黑盒 Gate 使用的固定身份解析器。
 * 它不读取客户端声称的租户 Header，且生产环境在构造阶段直接拒绝。
 */
export function createDevelopmentAuthResolver(input: {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly principals: readonly [DevelopmentAuthPrincipal, DevelopmentAuthPrincipal];
}): AuthContextResolver {
  if (input.runtimeEnvironment === "production") {
    throw new Error("DEVELOPMENT_AUTH_FORBIDDEN_IN_PRODUCTION");
  }
  const [first, second] = input.principals;
  if (
    first.userId.trim().length === 0 ||
    first.tenantId.trim().length === 0 ||
    second.userId.trim().length === 0 ||
    second.tenantId.trim().length === 0
  ) {
    throw new TypeError("开发身份不能为空");
  }
  if (first.userId === second.userId && first.tenantId === second.tenantId) {
    // 两个测试主体必须对应两条独立隔离路径；相同 principal 会把越权测试伪装成通过。
    throw new TypeError("开发身份 A 与 B 不能是同一 principal");
  }
  // Token 只是本地 fixture 选择器，不是可部署认证协议；调用方只能传入白名单中的两个值。
  const accepted = new Map<string, AuthPrincipal>([
    ["Bearer dev-user-a", Object.freeze({ ...first })],
    ["Bearer dev-user-b", Object.freeze({ ...second })],
  ]);
  return Object.freeze({
    resolve: async (input: { readonly authorization: string | undefined }) =>
      accepted.get(input.authorization ?? ""),
  });
}
