import { assertSameTenant, domainInvariant } from "./errors.js";
import type { Run, Thread } from "./execution.js";
import type {
  ArtifactId,
  IsoTimestamp,
  ResourceId,
  ResourceVersionId,
  RunId,
  Sha256Digest,
  TenantId,
  ThreadId,
  WorkspaceId,
  WorkspaceRevisionId,
} from "./ids.js";

export interface Workspace {
  readonly id: WorkspaceId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly currentRevisionNumber: number;
  readonly currentRevisionId?: WorkspaceRevisionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface WorkspaceRevision {
  readonly id: WorkspaceRevisionId;
  readonly workspaceId: WorkspaceId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly revisionNumber: number;
  readonly parentRevisionId?: WorkspaceRevisionId;
  readonly createdByRunId: RunId;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly createdAt: IsoTimestamp;
}

export function createWorkspace(input: {
  readonly id: WorkspaceId;
  readonly thread: Thread;
  readonly now: IsoTimestamp;
}): Workspace {
  domainInvariant(
    input.thread.status === "active",
    "INVALID_STATE_TRANSITION",
    "不能为已归档任务创建工作区",
  );
  // Workspace 的 Tenant 所有权只能从 Thread 派生，并在生命周期内保持不变。
  return Object.freeze({
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    currentRevisionNumber: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function appendWorkspaceRevision(input: {
  readonly workspace: Workspace;
  readonly run: Run;
  readonly revisionId: WorkspaceRevisionId;
  readonly expectedCurrentRevisionNumber: number;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly now: IsoTimestamp;
}): { readonly workspace: Workspace; readonly revision: WorkspaceRevision } {
  assertSameTenant(input.workspace.tenantId, input.run.tenantId);
  domainInvariant(
    input.workspace.threadId === input.run.threadId,
    "OWNERSHIP_MISMATCH",
    "运行不属于当前工作区的任务",
  );
  domainInvariant(
    input.expectedCurrentRevisionNumber === input.workspace.currentRevisionNumber,
    "VERSION_CONFLICT",
    "工作区版本已经变化",
  );
  domainInvariant(input.objectKey.trim().length > 0, "INVALID_ARGUMENT", "对象存储键不能为空");

  const revision = Object.freeze<WorkspaceRevision>({
    id: input.revisionId,
    workspaceId: input.workspace.id,
    tenantId: input.workspace.tenantId,
    threadId: input.workspace.threadId,
    revisionNumber: input.workspace.currentRevisionNumber + 1,
    ...(input.workspace.currentRevisionId === undefined
      ? {}
      : { parentRevisionId: input.workspace.currentRevisionId }),
    createdByRunId: input.run.id,
    objectKey: input.objectKey,
    digest: input.digest,
    createdAt: input.now,
  });
  const workspace = Object.freeze<Workspace>({
    ...input.workspace,
    currentRevisionNumber: revision.revisionNumber,
    currentRevisionId: revision.id,
    updatedAt: input.now,
  });
  return Object.freeze({ workspace, revision });
}

export type ResourceOrigin = "upload" | "file_source" | "promoted_workspace" | "artifact";

export interface Resource {
  readonly id: ResourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly origin: ResourceOrigin;
  readonly latestVersionNumber: number;
  readonly latestVersionId?: ResourceVersionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface ResourceVersion {
  readonly id: ResourceVersionId;
  readonly resourceId: ResourceId;
  readonly tenantId: TenantId;
  readonly versionNumber: number;
  readonly parentVersionId?: ResourceVersionId;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly createdAt: IsoTimestamp;
}

export function createResource(input: {
  readonly id: ResourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly origin: ResourceOrigin;
  readonly now: IsoTimestamp;
}): Resource {
  const name = input.name.trim();
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "资源名称长度无效");
  return Object.freeze({
    id: input.id,
    tenantId: input.tenantId,
    name,
    origin: input.origin,
    latestVersionNumber: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function appendResourceVersion(input: {
  readonly resource: Resource;
  readonly tenantId: TenantId;
  readonly versionId: ResourceVersionId;
  readonly expectedLatestVersionNumber: number;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly now: IsoTimestamp;
}): { readonly resource: Resource; readonly version: ResourceVersion } {
  assertSameTenant(input.resource.tenantId, input.tenantId);
  domainInvariant(
    input.expectedLatestVersionNumber === input.resource.latestVersionNumber,
    "VERSION_CONFLICT",
    "资源版本已经变化",
  );
  domainInvariant(input.objectKey.trim().length > 0, "INVALID_ARGUMENT", "对象存储键不能为空");
  domainInvariant(input.mediaType.trim().length > 0, "INVALID_ARGUMENT", "媒体类型不能为空");
  domainInvariant(
    Number.isSafeInteger(input.sizeBytes) && input.sizeBytes >= 0,
    "INVALID_ARGUMENT",
    "资源大小无效",
  );

  // 版本对象创建后冻结；更新只会追加新版本，并返回新的 Resource 聚合快照。
  const version = Object.freeze<ResourceVersion>({
    id: input.versionId,
    resourceId: input.resource.id,
    tenantId: input.resource.tenantId,
    versionNumber: input.resource.latestVersionNumber + 1,
    ...(input.resource.latestVersionId === undefined
      ? {}
      : { parentVersionId: input.resource.latestVersionId }),
    objectKey: input.objectKey,
    digest: input.digest,
    mediaType: input.mediaType,
    sizeBytes: input.sizeBytes,
    createdAt: input.now,
  });
  const resource = Object.freeze<Resource>({
    ...input.resource,
    latestVersionNumber: version.versionNumber,
    latestVersionId: version.id,
    updatedAt: input.now,
  });
  return Object.freeze({ resource, version });
}

export type ArtifactStatus = "publishing" | "published" | "failed";

export interface Artifact {
  readonly id: ArtifactId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly resourceVersionId: ResourceVersionId;
  readonly name: string;
  readonly status: ArtifactStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export function createArtifact(input: {
  readonly id: ArtifactId;
  readonly run: Run;
  readonly resourceVersion: ResourceVersion;
  readonly name: string;
  readonly now: IsoTimestamp;
}): Artifact {
  assertSameTenant(input.run.tenantId, input.resourceVersion.tenantId);
  const name = input.name.trim();
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "交付物名称长度无效");
  return Object.freeze({
    id: input.id,
    tenantId: input.run.tenantId,
    threadId: input.run.threadId,
    runId: input.run.id,
    resourceVersionId: input.resourceVersion.id,
    name,
    status: "publishing",
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function transitionArtifact(
  artifact: Artifact,
  target: ArtifactStatus,
  now: IsoTimestamp,
): Artifact {
  const transitions: Readonly<Record<ArtifactStatus, readonly ArtifactStatus[]>> = {
    publishing: ["published", "failed"],
    failed: ["publishing"],
    published: [],
  };
  domainInvariant(
    transitions[artifact.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "交付物发布状态转换不被允许",
  );
  return Object.freeze({ ...artifact, status: target, updatedAt: now });
}
