import type {
  ArtifactId,
  ResourceVersionId,
  RunId,
  Sha256Digest,
  TenantId,
  ThreadId,
  UserId,
  WorkspaceRevisionId,
} from "@cube-runtime/domain";
import type { StableBlobRef } from "@cube-runtime/persistence";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import type { ArtifactExecutionAuthorization } from "./authorization.js";

export type ArtifactPurpose = "deliverable" | "diagnostic" | "trace";
export type DeliverableRequirement = "required" | "optional";
export type ArtifactPublicationStatus = "publishing" | "published" | "failed";

export interface DeliverableDeclaration {
  readonly key: string;
  readonly name: string;
  readonly requirement: DeliverableRequirement;
}

export interface ArtifactPublicationSnapshot {
  readonly artifactId: ArtifactId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly resourceVersionId: ResourceVersionId;
  readonly replacesArtifactId?: ArtifactId;
  readonly name: string;
  readonly purpose: ArtifactPurpose;
  /** deliverable 才能携带声明键；diagnostic/trace 永远不能进入用户交付投影。 */
  readonly deliverableKey?: string;
  readonly status: ArtifactPublicationStatus;
}

export interface ArtifactBlobBinding {
  readonly resourceVersionId: ResourceVersionId;
  /** 不可变 ResourceVersion 创建时固定的展示媒体类型。 */
  readonly mediaType: string;
  /** 必须是 ResourceVersion 已提交引用的确切 stable incarnation。 */
  readonly blob: StableBlobRef;
}

export interface UserRequestScope {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

/**
 * UserRequestScope 只是网关身份结果的数据载体，结构本身不能证明认证。
 * Repository 必须在每次调用中重新校验 active Membership 和完整所有权链。
 */
export interface ArtifactUserAuthorization {
  readonly scope: UserRequestScope;
  readonly authorizationRevision: string;
}

export type ArtifactRepositoryFailure =
  | "not_found"
  | "scope_mismatch"
  | "not_running"
  | "invalid_replacement"
  | "resource_mismatch"
  | "conflict"
  | "unavailable";

export type BeginArtifactPublicationResult =
  | {
      readonly outcome: "started" | "already_started" | "already_finished";
      readonly publication: ArtifactPublicationSnapshot;
      readonly binding: ArtifactBlobBinding;
    }
  | { readonly outcome: ArtifactRepositoryFailure };

export type FinishArtifactPublicationResult =
  | {
      readonly outcome: "applied" | "already_applied";
      readonly publication: ArtifactPublicationSnapshot;
    }
  | {
      readonly outcome:
        | "response_unknown"
        | "not_found"
        | "scope_mismatch"
        | "conflict"
        | "unavailable";
    };

export type ReadArtifactPublicationResult =
  | {
      readonly outcome: "found";
      readonly commandDigest: Sha256Digest;
      readonly publication: ArtifactPublicationSnapshot;
      readonly binding: ArtifactBlobBinding;
    }
  | { readonly outcome: "not_found" | "scope_mismatch" | "unavailable" };

export type DeclareDeliverablesResult =
  | { readonly outcome: "applied" | "already_applied"; readonly commandDigest: Sha256Digest }
  | {
      readonly outcome:
        | "response_unknown"
        | "not_found"
        | "scope_mismatch"
        | "not_running"
        | "conflict"
        | "unavailable";
    };

export type CompletionInspectionResult =
  | { readonly outcome: "ready" }
  | {
      readonly outcome: "not_ready";
      readonly blockers: readonly {
        readonly deliverableKey: string;
        readonly status: "missing" | "publishing" | "failed";
      }[];
    }
  | { readonly outcome: "not_found" | "scope_mismatch" | "unavailable" };

export interface AuthorizedArtifactDownload {
  readonly authorization: ArtifactUserAuthorization;
  readonly publication: ArtifactPublicationSnapshot;
  readonly binding: ArtifactBlobBinding;
}

export type AuthorizeArtifactDownloadResult =
  | { readonly outcome: "authorized"; readonly download: AuthorizedArtifactDownload }
  | { readonly outcome: "not_found" | "unavailable" };

export interface ArtifactDeliveryRepositoryPort {
  /**
   * 写端口必须逐字段重验 authorization 对应的已消费 permit、完整双栅栏、Attempt version、
   * toolName 与 argsDigest；类实例只阻断普通请求结构伪造，不能替代数据库事实。
   */
  declareDeliverables(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly commandDigest: Sha256Digest;
    readonly declarations: readonly DeliverableDeclaration[];
  }): Promise<DeclareDeliverablesResult>;
  readDeliverableDeclarationCommand(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
  }): Promise<DeclareDeliverablesResult | { readonly outcome: "not_found" }>;
  /**
   * 必须在单个事实源事务内校验 running Run、scope 所有权、ResourceVersion 不可变引用、
   * replacement 链和幂等摘要，并把 Artifact→ResourceVersion→stable Blob 身份固定下来。
   */
  beginPublication(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly commandDigest: Sha256Digest;
    readonly artifactId: ArtifactId;
    readonly resourceVersionId: ResourceVersionId;
    readonly replacesArtifactId?: ArtifactId;
    readonly name: string;
    readonly purpose: ArtifactPurpose;
    readonly deliverableKey?: string;
  }): Promise<BeginArtifactPublicationResult>;
  finishPublication(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
    readonly commandDigest: Sha256Digest;
    readonly artifactId: ArtifactId;
    readonly target: "published" | "failed";
  }): Promise<FinishArtifactPublicationResult>;
  readPublicationCommand(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly idempotencyKey: string;
  }): Promise<ReadArtifactPublicationResult>;
  inspectCompletion(input: {
    readonly scope: ExecutionScope;
    readonly workspaceRevisionId?: WorkspaceRevisionId;
  }): Promise<CompletionInspectionResult>;
  /** 每次列表请求都必须重新校验 Membership；实现不得只按裸 Tenant/Artifact ID 查询。 */
  listAuthorizedArtifacts(input: {
    readonly request: UserRequestScope;
    readonly runId: RunId;
  }): Promise<
    | { readonly outcome: "authorized"; readonly artifacts: readonly ArtifactPublicationSnapshot[] }
    | { readonly outcome: "not_found" | "unavailable" }
  >;
  /** 授权与绑定解析必须在同一一致性读取中完成，未发布或非 deliverable 统一返回 not_found。 */
  authorizeDownload(input: {
    readonly request: UserRequestScope;
    readonly artifactId: ArtifactId;
  }): Promise<AuthorizeArtifactDownloadResult>;
  /** 预签名后再次检查授权版本、Artifact 状态及完整 Blob 身份，避免竞态下返回漂移链接。 */
  confirmDownloadAuthorization(
    input: AuthorizedArtifactDownload,
  ): Promise<
    | { readonly outcome: "confirmed" }
    | { readonly outcome: "not_found" | "changed" | "unavailable" }
  >;
}
