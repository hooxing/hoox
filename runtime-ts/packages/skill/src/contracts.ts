import type { IsoTimestamp, TenantId, UserId } from "@cube-runtime/domain";

export interface TrustedSkillContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

export interface SkillCatalogItem {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly description: string;
  readonly recommendedVersion: string;
  readonly compatibility: string;
  readonly securityStatus: "verified" | "restricted";
}

export interface SkillCatalogPage {
  readonly items: readonly SkillCatalogItem[];
  readonly nextCanonicalKey?: string;
}

export type SkillInstallationStatus = "enabled" | "disabled";

export interface SkillInstallation {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly description: string;
  readonly skillVersion: string;
  readonly invocationName: string;
  readonly status: SkillInstallationStatus;
  readonly versionToken: number;
  readonly installedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type SkillInstallResult =
  | { readonly outcome: "installed" | "replayed"; readonly installation: SkillInstallation }
  | {
      readonly outcome:
        | "not_found"
        | "key_conflict"
        | "already_installed"
        | "name_conflict"
        | "limit_exceeded";
    };

export type SkillConfigureResult =
  | { readonly outcome: "updated" | "replayed"; readonly installation: SkillInstallation }
  | {
      readonly outcome: "not_found" | "key_conflict" | "version_conflict" | "name_conflict";
    };

export type SkillUninstallResult =
  | { readonly outcome: "uninstalled" | "replayed" }
  | {
      readonly outcome: "not_found" | "key_conflict" | "version_conflict";
    };

export interface SkillCenterPort {
  listCatalog(input: {
    readonly context: TrustedSkillContext;
    readonly normalizedQuery: string;
    readonly limit: number;
    readonly afterCanonicalKey?: string;
  }): Promise<SkillCatalogPage>;

  listInstallations(input: {
    readonly context: TrustedSkillContext;
  }): Promise<readonly SkillInstallation[]>;

  install(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly versionSelector: "recommended" | string;
    readonly invocationName: string;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<SkillInstallResult>;

  configure(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly expectedVersionToken: number;
    readonly versionSelector?: "recommended" | string;
    readonly invocationName?: string;
    readonly enabled?: boolean;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<SkillConfigureResult>;

  uninstall(input: {
    readonly context: TrustedSkillContext;
    readonly canonicalKey: string;
    readonly expectedVersionToken: number;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<SkillUninstallResult>;
}
