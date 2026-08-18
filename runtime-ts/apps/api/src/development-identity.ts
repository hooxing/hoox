import {
  createPersonalTenant,
  createUser,
  type IsoTimestamp,
  isoTimestamp,
  membershipId,
  tenantId,
  userId,
} from "@hoox/domain";
import type { TenantBundle, TenantRepository } from "@hoox/persistence";
import {
  booleanEnvironmentField,
  EnvironmentConfigurationError,
  parseStrictEnvironment,
  type RuntimeEnvironment,
  readRequiredEnvironmentValue,
  selectDeclaredEnvironment,
  stringEnvironmentField,
  urlEnvironmentField,
} from "@hoox/process-runtime";
import {
  type ApiDevelopmentPrincipal,
  assertDevelopmentPrincipalsIsolated,
} from "./development-boundary.js";

const optionalEnvironments = [] as const;
const developmentAndTestEnvironments = ["development", "test"] as const;
const developmentIdentityEnvironmentSchema = Object.freeze({
  DATABASE_URL: urlEnvironmentField({
    secret: true,
    protocols: ["postgres:", "postgresql:"],
    allowCredentials: true,
    maxLength: 8_192,
  }),
  DATABASE_SCHEMA: stringEnvironmentField({ maxLength: 63 }),
  DEV_AUTH_ENABLED: booleanEnvironmentField({ requiredIn: developmentAndTestEnvironments }),
  DEV_AUTH_USER_A_ID: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 128 }),
  DEV_AUTH_USER_A_TENANT_ID: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 128,
  }),
  DEV_AUTH_USER_B_ID: stringEnvironmentField({ requiredIn: optionalEnvironments, maxLength: 128 }),
  DEV_AUTH_USER_B_TENANT_ID: stringEnvironmentField({
    requiredIn: optionalEnvironments,
    maxLength: 128,
  }),
});

export const developmentIdentityEnvironmentKeys = Object.freeze(
  Object.keys(developmentIdentityEnvironmentSchema),
);

export interface DevelopmentIdentityConfiguration {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly databaseUrl: string;
  readonly databaseSchema: string;
  readonly principals?: readonly [ApiDevelopmentPrincipal, ApiDevelopmentPrincipal];
}

export function selectDevelopmentIdentityEnvironment(
  source: NodeJS.ProcessEnv,
): Readonly<Record<string, string | undefined>> {
  return selectDeclaredEnvironment(source, developmentIdentityEnvironmentKeys);
}

/** 初始化命令不依赖游标、监听端口等 API 启动配置，但仍使用同一严格配置解析器。 */
export function parseDevelopmentIdentityEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): DevelopmentIdentityConfiguration {
  const parsed = parseStrictEnvironment(source, developmentIdentityEnvironmentSchema);
  if (parsed.runtimeEnvironment === "production") {
    assertProductionHasNoDevelopmentIdentity(source);
  }
  const enabled =
    parsed.runtimeEnvironment === "production"
      ? false
      : readRequiredEnvironmentValue(parsed, "DEV_AUTH_ENABLED");
  const principals = enabled
    ? Object.freeze([
        Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_ID"),
          tenantId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_A_TENANT_ID"),
        }),
        Object.freeze({
          userId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_B_ID"),
          tenantId: readRequiredEnvironmentValue(parsed, "DEV_AUTH_USER_B_TENANT_ID"),
        }),
      ] as const)
    : undefined;
  if (principals !== undefined) assertDevelopmentPrincipalsIsolated(principals);
  return Object.freeze({
    runtimeEnvironment: parsed.runtimeEnvironment,
    databaseUrl: readRequiredEnvironmentValue(parsed, "DATABASE_URL"),
    databaseSchema: readRequiredEnvironmentValue(parsed, "DATABASE_SCHEMA"),
    ...(principals === undefined ? {} : { principals }),
  });
}

function assertProductionHasNoDevelopmentIdentity(
  source: Readonly<Record<string, string | undefined>>,
): void {
  const keys = [
    "DEV_AUTH_ENABLED",
    "DEV_AUTH_USER_A_ID",
    "DEV_AUTH_USER_A_TENANT_ID",
    "DEV_AUTH_USER_B_ID",
    "DEV_AUTH_USER_B_TENANT_ID",
  ] as const;
  const configured = keys.filter((key) => source[key] !== undefined);
  if (configured.length > 0) {
    throw new EnvironmentConfigurationError(
      configured.map((key) => ({ code: "FORBIDDEN_IN_PRODUCTION" as const, key })),
    );
  }
}

export interface DevelopmentIdentityProvisioningResult {
  readonly label: "A" | "B";
  readonly outcome: "created" | "unchanged";
}

function bundleMatchesPrincipal(bundle: TenantBundle, principal: ApiDevelopmentPrincipal): boolean {
  return (
    bundle.user.id === principal.userId &&
    bundle.tenant.id === principal.tenantId &&
    bundle.tenant.kind === "personal" &&
    bundle.tenant.ownerUserId === principal.userId &&
    bundle.membership.tenantId === principal.tenantId &&
    bundle.membership.userId === principal.userId &&
    bundle.membership.role === "owner" &&
    bundle.membership.status === "active"
  );
}

function createBundle(
  principal: ApiDevelopmentPrincipal,
  label: "A" | "B",
  now: IsoTimestamp,
): TenantBundle {
  const user = createUser(userId(principal.userId), now);
  const personal = createPersonalTenant({
    id: tenantId(principal.tenantId),
    ownerMembershipId: membershipId(`membership_development_${label.toLowerCase()}`),
    owner: user,
    createdAt: now,
  });
  return Object.freeze({
    user,
    tenant: personal.tenant,
    membership: personal.ownerMembership,
  });
}

/**
 * 只由显式开发命令调用。每个个人租户聚合仍通过正式 Repository 的租户事务和 RLS 写入；
 * API 常驻装配不会引用本函数，因此启动服务永远不会隐式改变授权数据。
 */
export async function provisionDevelopmentIdentities(input: {
  readonly runtimeEnvironment: RuntimeEnvironment;
  readonly principals: readonly [ApiDevelopmentPrincipal, ApiDevelopmentPrincipal];
  readonly tenantRepository: TenantRepository;
  readonly now?: () => IsoTimestamp;
}): Promise<readonly DevelopmentIdentityProvisioningResult[]> {
  if (input.runtimeEnvironment !== "development") {
    throw new Error("DEVELOPMENT_IDENTITY_PROVISIONING_FORBIDDEN");
  }
  assertDevelopmentPrincipalsIsolated(input.principals);
  const [first, second] = input.principals;

  const results: DevelopmentIdentityProvisioningResult[] = [];
  for (const [label, principal] of [
    ["A", first],
    ["B", second],
  ] as const) {
    const scope = { tenantId: tenantId(principal.tenantId), userId: userId(principal.userId) };
    const existing = await input.tenantRepository.get(scope);
    if (existing !== undefined) {
      if (!bundleMatchesPrincipal(existing, principal)) {
        throw new Error(`DEVELOPMENT_IDENTITY_${label}_CONFLICT`);
      }
      results.push(Object.freeze({ label, outcome: "unchanged" }));
      continue;
    }

    const now = input.now?.() ?? isoTimestamp(new Date().toISOString());
    const created = await input.tenantRepository.createPersonal(
      createBundle(principal, label, now),
    );
    if (created.outcome === "created") {
      results.push(Object.freeze({ label, outcome: "created" }));
      continue;
    }

    // 并发命令可能已提交同一聚合；只在重新读取并逐项验证后把冲突视为幂等成功。
    const raced = await input.tenantRepository.get(scope);
    if (raced === undefined || !bundleMatchesPrincipal(raced, principal)) {
      throw new Error(`DEVELOPMENT_IDENTITY_${label}_CONFLICT`);
    }
    results.push(Object.freeze({ label, outcome: "unchanged" }));
  }
  return Object.freeze(results);
}
