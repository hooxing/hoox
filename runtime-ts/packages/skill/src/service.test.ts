import { tenantId, userId, isoTimestamp } from "@aisay/domain";
import { describe, expect, it } from "vitest";
import type {
  SkillCenterPort,
  SkillInstallResult,
  SkillInstallation,
  TrustedSkillContext,
} from "./contracts.js";
import type { SkillServiceError } from "./errors.js";
import { SkillCenterService } from "./service.js";

const context: TrustedSkillContext = Object.freeze({
  tenantId: tenantId("tenant_test"),
  userId: userId("user_test"),
});
const installation: SkillInstallation = Object.freeze({
  canonicalKey: "code-review",
  displayName: "代码审阅",
  publisher: "Cube",
  description: "按照团队检查清单审阅代码变更",
  skillVersion: "1.2.3",
  invocationName: "review",
  status: "enabled",
  versionToken: 0,
  installedAt: isoTimestamp("2099-08-02T08:00:00.000Z"),
  updatedAt: isoTimestamp("2099-08-02T08:00:00.000Z"),
});

class FakeSkillCenterPort implements SkillCenterPort {
  installResult: SkillInstallResult = { outcome: "installed", installation };
  lastCatalogInput: Parameters<SkillCenterPort["listCatalog"]>[0] | undefined;
  lastInstallInput: Parameters<SkillCenterPort["install"]>[0] | undefined;

  async listCatalog(input: Parameters<SkillCenterPort["listCatalog"]>[0]) {
    this.lastCatalogInput = input;
    return {
      items: [
        {
          canonicalKey: "code-review",
          displayName: "代码审阅",
          publisher: "Cube",
          description: "按照团队检查清单审阅代码变更",
          recommendedVersion: "1.2.3",
          compatibility: "runtime >= 1",
          securityStatus: "verified" as const,
        },
      ],
    };
  }

  async listInstallations() {
    return [installation];
  }

  async install(input: Parameters<SkillCenterPort["install"]>[0]) {
    this.lastInstallInput = input;
    return this.installResult;
  }

  async configure() {
    return { outcome: "updated" as const, installation };
  }

  async uninstall() {
    return { outcome: "uninstalled" as const };
  }
}

describe("Skill Center 领域服务", () => {
  it("规范化目录查询并保持公开目录的稳定排序", async () => {
    const port = new FakeSkillCenterPort();
    const service = new SkillCenterService(port);
    const page = await service.browse({ context, query: "  Code  ", limit: 30 });
    expect(page.items[0]?.canonicalKey).toBe("code-review");
    expect(port.lastCatalogInput).toMatchObject({ normalizedQuery: "code", limit: 30 });
  });

  it("安装只从可信上下文取用户并生成与请求绑定的内部幂等摘要", async () => {
    const port = new FakeSkillCenterPort();
    const service = new SkillCenterService(port);
    await service.install({
      context,
      canonicalKey: "code-review",
      version: "recommended",
      invocationName: "review",
      idempotencyKey: "skill-install-0001",
    });
    expect(port.lastInstallInput).toMatchObject({
      context,
      canonicalKey: "code-review",
      versionSelector: "recommended",
      invocationName: "review",
      idempotencyKey: "skill-install-0001",
    });
    expect(port.lastInstallInput?.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("拒绝平台保留调用名称并稳定映射安装冲突", async () => {
    const port = new FakeSkillCenterPort();
    const service = new SkillCenterService(port);
    await expect(
      service.install({
        context,
        canonicalKey: "code-review",
        version: "1.2.3",
        invocationName: "help",
        idempotencyKey: "skill-install-0002",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    port.installResult = { outcome: "name_conflict" };
    await expect(
      service.install({
        context,
        canonicalKey: "code-review",
        version: "1.2.3",
        invocationName: "review",
        idempotencyKey: "skill-install-0003",
      }),
    ).rejects.toEqual(expect.objectContaining<Partial<SkillServiceError>>({ code: "CONFLICT" }));
  });

  it("配置使用 CAS，卸载不允许缺少版本令牌", async () => {
    const service = new SkillCenterService(new FakeSkillCenterPort());
    await expect(
      service.configure({
        context,
        canonicalKey: "code-review",
        expectedVersionToken: 0,
        idempotencyKey: "skill-configure-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      service.uninstall({
        context,
        canonicalKey: "code-review",
        expectedVersionToken: -1,
        idempotencyKey: "skill-uninstall-0001",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
