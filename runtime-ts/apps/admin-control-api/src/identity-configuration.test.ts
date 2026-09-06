import { emptyIdentityConfiguration } from "@hoox/identity";
import type {
  IdentityConfigurationRepository,
  PersistedIdentityConfiguration,
} from "@hoox/persistence";
import { describe, expect, it, vi } from "vitest";
import { createIdentityAdminService } from "./identity-configuration.js";

describe("直接保存登录设置", () => {
  it("省略原因时自动审计，保存仍携带版本和幂等保护", async () => {
    let persisted: PersistedIdentityConfiguration | undefined;
    const save = vi.fn<IdentityConfigurationRepository["save"]>(async (input) => {
      persisted = { configuration: input.configuration, secrets: input.secrets };
      return "saved";
    });
    const service = createIdentityAdminService({
      repository: { read: async () => persisted, save },
      roles: { resolveRole: async () => "admin" },
      secret: "unit-identity-encryption-secret-at-least-32-bytes",
    });
    const context = {
      actorUserId: "admin",
      idempotencyKey: "identity-save-0001",
      requestDigest: "a".repeat(64),
    };
    const result = await service.update(context, {
      ...emptyIdentityConfiguration(),
      expectedVersionToken: 0,
      registrationEnabled: false,
    });
    expect(result.registrationEnabled).toBe(false);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        ...context,
        expectedVersionToken: 0,
        reason: "管理员保存登录设置",
      }),
    );
  });

  it("省略原因不能绕过管理员授权或连接配置校验", async () => {
    const save = vi.fn<IdentityConfigurationRepository["save"]>();
    const roles = { resolveRole: vi.fn(async () => "operator") };
    const service = createIdentityAdminService({
      repository: { read: async () => undefined, save },
      roles,
      secret: "unit-identity-encryption-secret-at-least-32-bytes",
    });
    const context = {
      actorUserId: "admin",
      idempotencyKey: "identity-save-0001",
      requestDigest: "a".repeat(64),
    };
    const command = {
      ...emptyIdentityConfiguration(),
      expectedVersionToken: 0,
      emailVerificationEnabled: true,
    };
    await expect(service.update(context, command)).rejects.toThrow("IDENTITY_ADMIN_NOT_AUTHORIZED");
    roles.resolveRole.mockResolvedValue("admin");
    await expect(service.update(context, command)).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});
