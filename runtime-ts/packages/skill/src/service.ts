import { createHash } from "node:crypto";
import type {
  SkillCatalogItem,
  SkillCatalogPage,
  SkillCenterPort,
  SkillInstallation,
  TrustedSkillContext,
} from "./contracts.js";
import { SkillServiceError, skillInvariant } from "./errors.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const invocationNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const reservedInvocationNames = new Set(["clear", "help", "new", "settings", "skills"]);

export class SkillCenterService {
  constructor(private readonly port: SkillCenterPort) {}

  async browse(input: {
    readonly context: TrustedSkillContext;
    readonly query?: string;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<SkillCatalogPage> {
    assertContext(input.context);
    const normalizedQuery = normalizeQuery(input.query ?? "");
    const limit = input.limit ?? 30;
    skillInvariant(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      "INVALID_REQUEST",
      "Skill 目录页大小无效",
    );
    if (input.cursor !== undefined) assertCanonicalKey(input.cursor);
    const page = await callPort(() =>
      this.port.listCatalog({
        context: input.context,
        normalizedQuery,
        limit,
        ...(input.cursor === undefined ? {} : { afterCanonicalKey: input.cursor }),
      }),
    );
    return validateCatalogPage(page, limit, input.cursor);
  }

  async listInstalled(context: TrustedSkillContext): Promise<readonly SkillInstallation[]> {
    assertContext(context);
    const installations = await callPort(() => this.port.listInstallations({ context }));
    const validated = installations.map(validateInstallation);
    for (let index = 1; index < validated.length; index += 1) {
      const previous = validated[index - 1];
      const current = validated[index];
      skillInvariant(
        previous !== undefined &&
          current !== undefined &&
          previous.invocationName < current.invocationName,
        "DEPENDENCY_UNAVAILABLE",
        "Skill 安装目录顺序无效",
      );
    }
    return Object.freeze(validated);
  }

  async install(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly version: "recommended" | string;
    readonly invocationName: string;
    readonly idempotencyKey: string;
  }): Promise<SkillInstallation> {
    assertContext(input.context);
    assertCanonicalKey(input.canonicalKey);
    assertVersionSelector(input.version);
    assertInvocationName(input.invocationName);
    assertIdempotencyKey(input.idempotencyKey);
    const result = await callPort(() =>
      this.port.install({
        context: input.context,
        canonicalKey: input.canonicalKey,
        versionSelector: input.version,
        invocationName: input.invocationName,
        idempotencyKey: input.idempotencyKey,
        requestDigest: requestDigest("install", [
          input.canonicalKey,
          input.version,
          input.invocationName,
        ]),
      }),
    );
    if (result.outcome === "installed" || result.outcome === "replayed") {
      return validateInstallation(result.installation);
    }
    throw resultFailure(result.outcome);
  }

  async configure(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly expectedVersionToken: number;
    readonly version?: "recommended" | string;
    readonly invocationName?: string;
    readonly enabled?: boolean;
    readonly idempotencyKey: string;
  }): Promise<SkillInstallation> {
    assertContext(input.context);
    assertCanonicalKey(input.canonicalKey);
    assertVersionToken(input.expectedVersionToken);
    if (input.version !== undefined) assertVersionSelector(input.version);
    if (input.invocationName !== undefined) assertInvocationName(input.invocationName);
    skillInvariant(
      input.version !== undefined ||
        input.invocationName !== undefined ||
        input.enabled !== undefined,
      "INVALID_REQUEST",
      "Skill 配置没有变更项",
    );
    assertIdempotencyKey(input.idempotencyKey);
    const result = await callPort(() =>
      this.port.configure({
        context: input.context,
        canonicalKey: input.canonicalKey,
        expectedVersionToken: input.expectedVersionToken,
        ...(input.version === undefined ? {} : { versionSelector: input.version }),
        ...(input.invocationName === undefined ? {} : { invocationName: input.invocationName }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        idempotencyKey: input.idempotencyKey,
        requestDigest: requestDigest("configure", [
          input.canonicalKey,
          input.expectedVersionToken,
          input.version ?? null,
          input.invocationName ?? null,
          input.enabled ?? null,
        ]),
      }),
    );
    if (result.outcome === "updated" || result.outcome === "replayed") {
      return validateInstallation(result.installation);
    }
    throw resultFailure(result.outcome);
  }

  async uninstall(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly expectedVersionToken: number;
    readonly idempotencyKey: string;
  }): Promise<void> {
    assertContext(input.context);
    assertCanonicalKey(input.canonicalKey);
    assertVersionToken(input.expectedVersionToken);
    assertIdempotencyKey(input.idempotencyKey);
    const result = await callPort(() =>
      this.port.uninstall({
        context: input.context,
        canonicalKey: input.canonicalKey,
        expectedVersionToken: input.expectedVersionToken,
        idempotencyKey: input.idempotencyKey,
        requestDigest: requestDigest("uninstall", [input.canonicalKey, input.expectedVersionToken]),
      }),
    );
    if (result.outcome === "uninstalled" || result.outcome === "replayed") return;
    throw resultFailure(result.outcome);
  }
}

function requestDigest(operation: string, fields: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...fields]))
    .digest("hex");
}

function resultFailure(outcome: string): SkillServiceError {
  switch (outcome) {
    case "not_found":
      return new SkillServiceError("NOT_FOUND", "Skill 不存在或版本不可安装");
    case "limit_exceeded":
      return new SkillServiceError("LIMIT_EXCEEDED", "已达到 Skill 安装上限");
    case "key_conflict":
    case "already_installed":
    case "name_conflict":
    case "version_conflict":
      return new SkillServiceError("CONFLICT", "Skill 安装状态已经变化");
    default:
      return new SkillServiceError("DEPENDENCY_UNAVAILABLE", "Skill Center 返回未知结果");
  }
}

async function callPort<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("DEPENDENCY_UNAVAILABLE", "Skill Center 暂时不可用");
  }
}

function assertContext(context: TrustedSkillContext): void {
  skillInvariant(
    idPattern.test(context.tenantId) && idPattern.test(context.userId),
    "INVALID_REQUEST",
    "Skill 认证上下文无效",
  );
}

function assertCanonicalKey(value: string): void {
  skillInvariant(canonicalKeyPattern.test(value), "INVALID_REQUEST", "Skill 规范键无效");
}

function assertVersionSelector(value: string): void {
  skillInvariant(
    value === "recommended" || versionPattern.test(value),
    "INVALID_REQUEST",
    "Skill 版本无效",
  );
}

function assertInvocationName(value: string): void {
  skillInvariant(
    invocationNamePattern.test(value) && !reservedInvocationNames.has(value.toLowerCase()),
    "INVALID_REQUEST",
    "Skill 调用名称无效或已被平台保留",
  );
}

function assertIdempotencyKey(value: string): void {
  skillInvariant(idempotencyKeyPattern.test(value), "INVALID_REQUEST", "幂等键无效");
}

function assertVersionToken(value: number): void {
  skillInvariant(
    Number.isSafeInteger(value) && value >= 0,
    "INVALID_REQUEST",
    "Skill 版本令牌无效",
  );
}

function normalizeQuery(value: string): string {
  const normalized = value.trim().toLowerCase();
  skillInvariant(
    Buffer.byteLength(normalized, "utf8") <= 256 && !hasControlCharacters(normalized),
    "INVALID_REQUEST",
    "Skill 查询无效",
  );
  return normalized;
}

function validateCatalogPage(
  page: SkillCatalogPage,
  limit: number,
  cursor: string | undefined,
): SkillCatalogPage {
  skillInvariant(
    Array.isArray(page.items) && page.items.length <= limit,
    "DEPENDENCY_UNAVAILABLE",
    "Skill 目录页无效",
  );
  const items = page.items.map(validateCatalogItem);
  for (let index = 0; index < items.length; index += 1) {
    const current = items[index];
    skillInvariant(current !== undefined, "DEPENDENCY_UNAVAILABLE", "Skill 目录条目缺失");
    const previous = index === 0 ? undefined : items[index - 1];
    skillInvariant(
      index === 0
        ? cursor === undefined || current.canonicalKey > cursor
        : previous !== undefined && previous.canonicalKey < current.canonicalKey,
      "DEPENDENCY_UNAVAILABLE",
      "Skill 目录顺序无效",
    );
  }
  if (page.nextCanonicalKey !== undefined) {
    assertCanonicalKey(page.nextCanonicalKey);
    skillInvariant(
      items.at(-1)?.canonicalKey === page.nextCanonicalKey,
      "DEPENDENCY_UNAVAILABLE",
      "Skill 目录游标无效",
    );
  }
  return Object.freeze({
    items: Object.freeze(items),
    ...(page.nextCanonicalKey === undefined ? {} : { nextCanonicalKey: page.nextCanonicalKey }),
  });
}

function validateCatalogItem(item: SkillCatalogItem): SkillCatalogItem {
  assertCanonicalKey(item.canonicalKey);
  assertVersionSelector(item.recommendedVersion);
  skillInvariant(
    item.recommendedVersion !== "recommended",
    "DEPENDENCY_UNAVAILABLE",
    "推荐版本未固定",
  );
  assertPlainText(item.displayName, 200, "Skill 显示名称无效");
  assertPlainText(item.publisher, 200, "Skill 发布者无效");
  assertPlainText(item.description, 2_048, "Skill 描述无效");
  assertPlainText(item.compatibility, 500, "Skill 兼容性说明无效");
  skillInvariant(
    item.securityStatus === "verified" || item.securityStatus === "restricted",
    "DEPENDENCY_UNAVAILABLE",
    "Skill 安全状态无效",
  );
  return Object.freeze({ ...item });
}

function validateInstallation(item: SkillInstallation): SkillInstallation {
  assertCanonicalKey(item.canonicalKey);
  assertVersionSelector(item.skillVersion);
  assertInvocationName(item.invocationName);
  assertVersionToken(item.versionToken);
  assertPlainText(item.displayName, 200, "Skill 显示名称无效");
  assertPlainText(item.publisher, 200, "Skill 发布者无效");
  assertPlainText(item.description, 2_048, "Skill 描述无效");
  skillInvariant(
    item.status === "enabled" || item.status === "disabled",
    "DEPENDENCY_UNAVAILABLE",
    "Skill 安装状态无效",
  );
  skillInvariant(
    Number.isFinite(Date.parse(item.installedAt)) && Number.isFinite(Date.parse(item.updatedAt)),
    "DEPENDENCY_UNAVAILABLE",
    "Skill 安装时间无效",
  );
  return Object.freeze({ ...item });
}

function assertPlainText(value: string, maxBytes: number, message: string): void {
  skillInvariant(
    value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxBytes &&
      !hasControlCharacters(value),
    "DEPENDENCY_UNAVAILABLE",
    message,
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}
