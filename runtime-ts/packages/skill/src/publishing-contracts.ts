import type { IsoTimestamp, UserId } from "@aisay/domain";

export type SkillPublicationRole = "publisher" | "reviewer" | "admin";
export type SkillPublicationStatus =
  | "draft"
  | "submitted"
  | "approved"
  | "rejected"
  | "published"
  | "revoked";

export interface SkillPublicationSource {
  readonly sourceUrl: string;
  readonly sourceRevision: string;
  readonly licenseSpdx: string;
}

export interface SkillPublicationMetadata extends SkillPublicationSource {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly version: string;
  readonly description: string;
  readonly compatibility: string;
}

export interface SkillPublicationUploadFile {
  readonly path: string;
  readonly mediaType: string;
  readonly contentBase64: string;
}

export interface ValidatedSkillPublicationFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  readonly body: Uint8Array;
}

export interface ValidatedSkillPublicationPackage {
  readonly metadata: SkillPublicationMetadata;
  readonly files: readonly ValidatedSkillPublicationFile[];
  readonly packageManifest: Uint8Array;
  readonly packageDigest: string;
  readonly entrypointDigest: string;
  readonly entrypointMarkdown: string;
  readonly totalBytes: number;
}

export interface SkillPublicationFileDescriptor {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
}

export interface SkillPublicationSubmission extends SkillPublicationMetadata {
  readonly submissionId: string;
  readonly status: SkillPublicationStatus;
  readonly securityStatus: "restricted";
  readonly packageDigest: string;
  readonly entrypointDigest: string;
  readonly entrypointMarkdown: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly versionToken: number;
  readonly createdBy: UserId;
  readonly reviewedBy?: UserId;
  readonly rejectionReason?: string;
  readonly files: readonly SkillPublicationFileDescriptor[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface SkillPublicationPage {
  readonly items: readonly SkillPublicationSubmission[];
  readonly nextSubmissionId?: string;
}

export interface SkillPublicationAuthorizationPort {
  resolveRole(userId: UserId): Promise<SkillPublicationRole | undefined>;
}

export type SkillPublicationCreateResult =
  | {
      readonly outcome: "created" | "replayed";
      readonly submission: SkillPublicationSubmission;
    }
  | { readonly outcome: "key_conflict" | "version_conflict" };

export type SkillPublicationCommandResult =
  | {
      readonly outcome: "updated" | "replayed";
      readonly submission: SkillPublicationSubmission;
    }
  | { readonly outcome: "not_found" | "version_conflict" | "state_conflict" };

export interface SkillPublicationPort {
  list(input: {
    readonly actorUserId: UserId;
    readonly limit: number;
    readonly afterSubmissionId?: string;
  }): Promise<SkillPublicationPage>;

  get(input: {
    readonly actorUserId: UserId;
    readonly submissionId: string;
  }): Promise<SkillPublicationSubmission | undefined>;

  create(input: {
    readonly actorUserId: UserId;
    readonly submissionId: string;
    readonly package: ValidatedSkillPublicationPackage;
    readonly idempotencyKey: string;
    readonly requestDigest: string;
  }): Promise<SkillPublicationCreateResult>;

  submit(input: SkillPublicationTransitionInput): Promise<SkillPublicationCommandResult>;

  review(
    input: SkillPublicationTransitionInput & {
      readonly decision: "approve" | "reject";
      readonly reason?: string;
    },
  ): Promise<SkillPublicationCommandResult>;

  publish(
    input: SkillPublicationTransitionInput & { readonly recommended: boolean },
  ): Promise<SkillPublicationCommandResult>;

  revoke(
    input: SkillPublicationTransitionInput & { readonly reason: string },
  ): Promise<SkillPublicationCommandResult>;
}

export interface SkillPublicationTransitionInput {
  readonly actorUserId: UserId;
  readonly submissionId: string;
  readonly expectedVersionToken: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}
