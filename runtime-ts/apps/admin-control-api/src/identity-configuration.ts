import {
  type EditableIdentityConfiguration,
  emptyIdentityConfiguration,
  type IdentityConfiguration,
  normalizeEditableIdentityConfiguration,
} from "@hoox/identity";
import type {
  IdentityConfigurationRepository,
  PersistedIdentityConfiguration,
} from "@hoox/persistence/admin";

export interface IdentityAdminMutationContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

export interface IdentityAdminService {
  read(actorUserId: string): Promise<IdentityConfiguration>;
  update(
    context: IdentityAdminMutationContext,
    input: EditableIdentityConfiguration & { readonly reason?: string },
  ): Promise<IdentityConfiguration>;
}

function requireAdmin(role: string | undefined): void {
  if (role !== "admin") throw new Error("IDENTITY_ADMIN_NOT_AUTHORIZED");
}

export function createIdentityAdminService(input: {
  readonly repository: IdentityConfigurationRepository;
  readonly roles: { resolveRole(userId: string): Promise<string | undefined> };
  readonly secret: string;
}): IdentityAdminService {
  const readPersisted = (
    actorUserId: string,
  ): Promise<PersistedIdentityConfiguration | undefined> =>
    input.repository.read(input.secret, actorUserId);
  return Object.freeze({
    async read(actorUserId: string) {
      requireAdmin(await input.roles.resolveRole(actorUserId));
      return (await readPersisted(actorUserId))?.configuration ?? emptyIdentityConfiguration();
    },
    async update(
      context: IdentityAdminMutationContext,
      command: EditableIdentityConfiguration & { readonly reason?: string },
    ) {
      requireAdmin(await input.roles.resolveRole(context.actorUserId));
      const reason = (command.reason ?? "管理员保存登录设置").trim();
      if (reason.length === 0 || reason.length > 500)
        throw new TypeError("IDENTITY_REASON_INVALID");
      const current = await readPersisted(context.actorUserId);
      const normalized = normalizeEditableIdentityConfiguration(
        {
          expectedVersionToken: command.expectedVersionToken,
          emailPasswordEnabled: command.emailPasswordEnabled,
          emailVerificationEnabled: command.emailVerificationEnabled,
          ...(command.emailFromAddress === undefined
            ? {}
            : { emailFromAddress: command.emailFromAddress }),
          ...(command.emailFromName === undefined ? {} : { emailFromName: command.emailFromName }),
          ...(command.smtpHost === undefined ? {} : { smtpHost: command.smtpHost }),
          smtpPort: command.smtpPort,
          smtpSecure: command.smtpSecure,
          ...(command.smtpUsername === undefined ? {} : { smtpUsername: command.smtpUsername }),
          ...(command.smtpPassword === undefined ? {} : { smtpPassword: command.smtpPassword }),
          registrationEnabled: command.registrationEnabled,
          phoneEnabled: command.phoneEnabled,
          ...(command.smsWebhookUrl === undefined ? {} : { smsWebhookUrl: command.smsWebhookUrl }),
          ...(command.smsWebhookSecret === undefined
            ? {}
            : { smsWebhookSecret: command.smsWebhookSecret }),
          providers: command.providers,
        },
        current?.secrets ?? { providerSecrets: {} },
      );
      const outcome = await input.repository.save({
        actorUserId: context.actorUserId,
        expectedVersionToken: command.expectedVersionToken,
        idempotencyKey: context.idempotencyKey,
        requestDigest: context.requestDigest,
        reason,
        configuration: normalized.configuration,
        secrets: normalized.secrets,
        secret: input.secret,
      });
      if (outcome === "conflict") throw new Error("IDENTITY_ADMIN_CONFLICT");
      const saved = await readPersisted(context.actorUserId);
      if (saved === undefined) throw new Error("IDENTITY_ADMIN_SAVE_NOT_VISIBLE");
      return saved.configuration;
    },
  });
}
