import type {
  AgentThreadId,
  IsoTimestamp,
  Resource,
  ResourceId,
  ResourceOrigin,
  ResourceVersion,
  ResourceVersionId,
  RunId,
  Sha256Digest,
  TenantId,
  ThreadId,
  UserId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "@hoox/domain";

/**
 * 只能接收认证层在重验 Membership 后提供的上下文；运行时格式校验是纵深防御，
 * 本结构本身不是不可伪造 capability，也不能证明调用者已经完成认证。
 */
export interface TrustedResourceContext {
  readonly tenantId: TenantId;
  readonly userId: UserId;
}

/** 只由已签发 promote capability 的 verifier 恢复，公开请求不能直接提交本结构。 */
export interface AuthorizedAgentResourceContext extends TrustedResourceContext {
  readonly actor: {
    readonly kind: "agent";
    readonly agentThreadId: AgentThreadId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  };
}

/** JSON 序列化后会丢失 registry 身份；服务只把它作为 unknown 交给 verifier。 */
export interface PromoteResourceCapability {
  readonly kind: "promote_resource_capability";
}

/** issuer 只交给受控 Tool Router；Resource 服务装配只持有 verifier。 */
export interface PromotionCapabilityIssuer {
  issue(context: AuthorizedAgentResourceContext): PromoteResourceCapability;
}

export interface PromotionCapabilityVerifier {
  verify(capability: unknown): AuthorizedAgentResourceContext | undefined;
}

export interface ResourceSearchPosition {
  readonly updatedAt: IsoTimestamp;
  readonly resourceId: ResourceId;
}

/** 发现结果刻意不包含对象键、内容、签名地址或来源 Thread。 */
export interface ResourceSearchItem {
  readonly resourceId: ResourceId;
  readonly versionId: ResourceVersionId;
  readonly versionNumber: number;
  readonly name: string;
  readonly origin: ResourceOrigin;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly updatedAt: IsoTimestamp;
}

/** Repository 内部行；tenantId 和 visibility 在公开投影前必须再次校验。 */
export interface ResourceCatalogItem extends ResourceSearchItem {
  readonly tenantId: TenantId;
  readonly visibility: "searchable" | "pending_explicit_commit";
}

export interface ResourceCatalogPage {
  readonly items: readonly ResourceCatalogItem[];
  readonly nextPosition?: ResourceSearchPosition;
}

export interface ResourceSearchResult {
  readonly items: readonly ResourceSearchItem[];
  readonly nextCursor?: string;
}

/**
 * 持久化实现必须先按认证上下文授权，并按 updatedAt DESC、resourceId DESC 排序。
 * searchable=false 的过程文件根本不能进入本端口的结果集合。
 */
export interface ResourceCatalog {
  search(input: {
    readonly context: TrustedResourceContext;
    readonly normalizedQuery: string;
    readonly limit: number;
    readonly after?: ResourceSearchPosition;
  }): Promise<ResourceCatalogPage>;
  resolveVersion(input: {
    readonly context: TrustedResourceContext;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
  }): Promise<
    | { readonly status: "found"; readonly resource: Resource; readonly version: ResourceVersion }
    | { readonly status: "not_found" }
  >;
}

export interface ResourceCursorCodec {
  encode(input: {
    readonly context: TrustedResourceContext;
    readonly normalizedQuery: string;
    readonly position: ResourceSearchPosition;
  }): string;
  decode(input: {
    readonly context: TrustedResourceContext;
    readonly normalizedQuery: string;
    readonly cursor: string;
  }): ResourceSearchPosition;
}

export interface ResourceByteRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * version 只能来自同一次服务调用中的授权目录解析，公开命令没有 objectKey 参数。
 * 适配器应从规范 ResourceVersion 映射内部 Blob 引用，不能信任响应头或调用方定位符。
 */
export interface ResourceContentReader {
  readRange(input: {
    readonly context: TrustedResourceContext;
    readonly version: ResourceVersion;
    readonly range: ResourceByteRange;
  }): Promise<Uint8Array>;
}

export type ResourcePreviewResult =
  | {
      readonly status: "available";
      readonly resourceId: ResourceId;
      readonly versionId: ResourceVersionId;
      readonly mediaType: string;
      readonly range: ResourceByteRange;
      readonly totalSizeBytes: number;
      readonly truncated: boolean;
      readonly bytes: Uint8Array;
    }
  | {
      readonly status: "unsupported_media_type";
      readonly mediaType: string;
    }
  | { readonly status: "range_not_satisfiable"; readonly totalSizeBytes: number }
  | { readonly status: "not_found" };

export type WorkspaceImportTargetInspection =
  | { readonly status: "available" }
  | { readonly status: "occupied" }
  | { readonly status: "not_found" };

/** M2 Workspace 集成点：未来实现必须重验 Tenant、Workspace 与目标路径当前状态。 */
export interface WorkspaceImportTargetInspector {
  inspect(input: {
    readonly context: TrustedResourceContext;
    readonly workspaceId: WorkspaceId;
    readonly safeRelativePath: string;
  }): Promise<WorkspaceImportTargetInspection>;
}

export interface ResourceImportPlan {
  readonly kind: "resource_import_plan";
  readonly planVersion: 1;
  readonly snapshot: {
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
    readonly versionNumber: number;
    readonly digest: Sha256Digest;
    readonly mediaType: string;
    readonly sizeBytes: number;
  };
  readonly target: {
    readonly workspaceId: WorkspaceId;
    readonly relativePath: string;
    readonly conflictPolicy: "reject";
    readonly precondition: "target_absent";
  };
  /** 计划不是写入授权；物化器之后必须在 Writer Lease 下重验版本和目标冲突。 */
  readonly materialization: "not_started";
  readonly workspaceWriterLease: "not_acquired";
}

export type ResourceImportPlanResult =
  | { readonly status: "planned"; readonly plan: ResourceImportPlan }
  | { readonly status: "target_conflict" }
  | { readonly status: "not_found" };

export interface WorkspacePromotionSnapshotAuthorization {
  readonly authorizationId: string;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly revisionId: WorkspaceRevisionId;
  readonly relativePath: string;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly expiresAt: IsoTimestamp;
}

/**
 * 由 Workspace 事实源在 Agent 执行身份、Revision 和路径都通过授权后签发。
 * 此端口不创建 Resource；持久化提升与 Blob promotion 由后续事务协议完成。
 */
export interface WorkspacePromotionAuthorizer {
  authorizeSnapshot(input: {
    readonly context: AuthorizedAgentResourceContext;
    readonly workspaceId: WorkspaceId;
    readonly revisionId: WorkspaceRevisionId;
    readonly safeRelativePath: string;
  }): Promise<
    | {
        readonly status: "authorized";
        readonly authorization: WorkspacePromotionSnapshotAuthorization;
      }
    | { readonly status: "not_found" | "not_authorized" }
  >;
}

export interface PromoteResourceRequest {
  readonly workspaceId: WorkspaceId;
  readonly revisionId: WorkspaceRevisionId;
  readonly relativePath: string;
  readonly resourceName: string;
}

export type PromoteResourceRequestResult =
  | {
      readonly status: "authorized";
      readonly request: {
        readonly kind: "promote_resource";
        readonly resourceName: string;
        readonly origin: "promoted_workspace";
        readonly source: WorkspacePromotionSnapshotAuthorization;
        readonly catalogVisibility: "pending_explicit_commit";
      };
    }
  | { readonly status: "not_found" | "not_authorized" };
