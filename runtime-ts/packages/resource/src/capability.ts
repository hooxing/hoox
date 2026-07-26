import type {
  AuthorizedAgentResourceContext,
  PromoteResourceCapability,
  PromotionCapabilityIssuer,
  PromotionCapabilityVerifier,
} from "./contracts.js";
import { resourceInvariant } from "./errors.js";

export interface PromotionCapabilityRegistry {
  /** 只交给受控 Tool Router，绝不能注入 HTTP/JSON 请求处理器。 */
  readonly issuer: PromotionCapabilityIssuer;
  /** 只交给 ResourceLibraryService。 */
  readonly verifier: PromotionCapabilityVerifier;
}

/**
 * WeakMap 的对象身份是实际 capability。调用者即使完整复制可枚举字段，
 * 也不能构造 registry 已签发的对象身份；进程重启后旧 capability 自动失效。
 */
export function createPromotionCapabilityRegistry(): PromotionCapabilityRegistry {
  const grants = new WeakMap<object, AuthorizedAgentResourceContext>();
  const issuer: PromotionCapabilityIssuer = Object.freeze({
    issue(context: AuthorizedAgentResourceContext): PromoteResourceCapability {
      assertAgentContext(context);
      const capability = Object.freeze({ kind: "promote_resource_capability" as const });
      grants.set(capability, freezeAgentContext(context));
      return capability;
    },
  });
  const verifier: PromotionCapabilityVerifier = Object.freeze({
    verify(capability: unknown): AuthorizedAgentResourceContext | undefined {
      if (typeof capability !== "object" || capability === null) return undefined;
      return grants.get(capability);
    },
  });
  return Object.freeze({ issuer, verifier });
}

function freezeAgentContext(
  context: AuthorizedAgentResourceContext,
): AuthorizedAgentResourceContext {
  return Object.freeze({
    tenantId: context.tenantId,
    userId: context.userId,
    actor: Object.freeze({
      kind: "agent",
      agentThreadId: context.actor.agentThreadId,
      threadId: context.actor.threadId,
      runId: context.actor.runId,
    }),
  });
}

function assertAgentContext(context: AuthorizedAgentResourceContext): void {
  resourceInvariant(
    typeof context === "object" &&
      context !== null &&
      context.actor?.kind === "agent" &&
      validId(context.tenantId) &&
      validId(context.userId) &&
      validId(context.actor.agentThreadId) &&
      validId(context.actor.threadId) &&
      validId(context.actor.runId),
    "NOT_AUTHORIZED",
    "不能签发 Resource 提升能力",
  );
}

function validId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value);
}
