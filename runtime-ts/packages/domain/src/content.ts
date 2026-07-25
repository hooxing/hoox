import { sealEntity, type Entity } from "./entity.js";
import { assertSameTenant, domainInvariant } from "./errors.js";
import type { Run, Thread } from "./execution.js";
import {
  artifactId,
  isoTimestamp,
  resourceId,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  workspaceId,
  workspaceRevisionId,
  type ArtifactId,
  type IsoTimestamp,
  type ResourceId,
  type ResourceVersionId,
  type RunId,
  type Sha256Digest,
  type TenantId,
  type ThreadId,
  type WorkspaceId,
  type WorkspaceRevisionId,
} from "./ids.js";
import {
  enumValue,
  integerValue,
  optionalStringValue,
  recordValue,
  stringValue,
} from "./validation.js";

export interface WorkspaceWriterLease {
  readonly rootRunId: RunId;
  readonly epoch: number;
  readonly expiresAt: IsoTimestamp;
}

interface WorkspaceData {
  readonly id: WorkspaceId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly currentRevisionNumber: number;
  readonly currentRevisionId?: WorkspaceRevisionId;
  readonly leaseEpoch: number;
  readonly writerLease?: WorkspaceWriterLease;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Workspace = Entity<"Workspace", WorkspaceData>;

interface WorkspaceRevisionData {
  readonly id: WorkspaceRevisionId;
  readonly workspaceId: WorkspaceId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly revisionNumber: number;
  readonly parentRevisionId?: WorkspaceRevisionId;
  readonly createdByRunId: RunId;
  readonly leaseEpoch: number;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly createdAt: IsoTimestamp;
}
export type WorkspaceRevision = Entity<"WorkspaceRevision", WorkspaceRevisionData>;

export interface WorkspaceRevisionCommit {
  readonly expectedCurrentRevisionNumber: number;
  readonly expectedLeaseEpoch: number;
  readonly workspace: Workspace;
  readonly revision: WorkspaceRevision;
}

function timestampMillis(value: IsoTimestamp): number {
  return new Date(value).valueOf();
}

function assertRunOwnsWorkspace(workspace: Workspace, run: Run): void {
  assertSameTenant(workspace.tenantId, run.tenantId);
  domainInvariant(
    workspace.threadId === run.threadId,
    "OWNERSHIP_MISMATCH",
    "运行不属于当前工作区的任务",
  );
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
  return sealEntity("Workspace", {
    id: input.id,
    tenantId: input.thread.tenantId,
    threadId: input.thread.id,
    currentRevisionNumber: 0,
    leaseEpoch: 0,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

export function acquireWorkspaceLease(input: {
  readonly workspace: Workspace;
  readonly rootRun: Run;
  readonly epoch: number;
  readonly expiresAt: IsoTimestamp;
  readonly now: IsoTimestamp;
}): Workspace {
  assertRunOwnsWorkspace(input.workspace, input.rootRun);
  domainInvariant(
    input.rootRun.status === "running",
    "INVALID_STATE_TRANSITION",
    "只有运行中的根 Run 可以取得工作区写租约",
  );
  domainInvariant(
    input.workspace.writerLease === undefined ||
      timestampMillis(input.workspace.writerLease.expiresAt) <= timestampMillis(input.now),
    "VERSION_CONFLICT",
    "工作区已有有效写租约",
  );
  domainInvariant(
    input.epoch === input.workspace.leaseEpoch + 1,
    "VERSION_CONFLICT",
    "工作区租约 epoch 无效",
  );
  domainInvariant(
    timestampMillis(input.expiresAt) > timestampMillis(input.now),
    "INVALID_ARGUMENT",
    "工作区租约必须在未来到期",
  );
  const writerLease = Object.freeze<WorkspaceWriterLease>({
    rootRunId: input.rootRun.id,
    epoch: input.epoch,
    expiresAt: input.expiresAt,
  });
  return sealEntity("Workspace", {
    ...input.workspace,
    leaseEpoch: input.epoch,
    writerLease,
    updatedAt: input.now,
  });
}

export function renewWorkspaceLease(input: {
  readonly workspace: Workspace;
  readonly rootRun: Run;
  readonly epoch: number;
  readonly expiresAt: IsoTimestamp;
  readonly now: IsoTimestamp;
}): Workspace {
  assertWorkspaceLease(input.workspace, input.rootRun, input.epoch, input.now);
  domainInvariant(
    input.rootRun.status === "running",
    "INVALID_STATE_TRANSITION",
    "只有运行中的根 Run 可以续租工作区",
  );
  domainInvariant(
    timestampMillis(input.expiresAt) > timestampMillis(input.now),
    "INVALID_ARGUMENT",
    "工作区租约必须在未来到期",
  );
  return sealEntity("Workspace", {
    ...input.workspace,
    writerLease: Object.freeze({
      rootRunId: input.rootRun.id,
      epoch: input.epoch,
      expiresAt: input.expiresAt,
    }),
    updatedAt: input.now,
  });
}

export function releaseWorkspaceLease(input: {
  readonly workspace: Workspace;
  readonly rootRun: Run;
  readonly epoch: number;
  readonly now: IsoTimestamp;
}): Workspace {
  assertWorkspaceLease(input.workspace, input.rootRun, input.epoch, input.now);
  const { writerLease: _released, ...data } = input.workspace;
  return sealEntity("Workspace", { ...data, updatedAt: input.now });
}

function assertWorkspaceLease(
  workspace: Workspace,
  rootRun: Run,
  epoch: number,
  now: IsoTimestamp,
): void {
  assertRunOwnsWorkspace(workspace, rootRun);
  domainInvariant(
    workspace.writerLease !== undefined &&
      workspace.writerLease.rootRunId === rootRun.id &&
      workspace.writerLease.epoch === epoch,
    "OWNERSHIP_MISMATCH",
    "当前运行不持有工作区写租约",
  );
  domainInvariant(
    timestampMillis(workspace.writerLease.expiresAt) > timestampMillis(now),
    "INVALID_STATE_TRANSITION",
    "工作区写租约已经到期",
  );
}

export function prepareWorkspaceRevision(input: {
  readonly workspace: Workspace;
  readonly rootRun: Run;
  readonly leaseEpoch: number;
  readonly revisionId: WorkspaceRevisionId;
  readonly objectKey: string;
  readonly digest: Sha256Digest;
  readonly now: IsoTimestamp;
}): WorkspaceRevisionCommit {
  assertWorkspaceLease(input.workspace, input.rootRun, input.leaseEpoch, input.now);
  domainInvariant(
    input.rootRun.status === "running",
    "INVALID_STATE_TRANSITION",
    "只有运行中的根 Run 可以提交工作区版本",
  );
  domainInvariant(input.objectKey.trim().length > 0, "INVALID_ARGUMENT", "对象存储键不能为空");
  const revision = sealEntity("WorkspaceRevision", {
    id: input.revisionId,
    workspaceId: input.workspace.id,
    tenantId: input.workspace.tenantId,
    threadId: input.workspace.threadId,
    revisionNumber: input.workspace.currentRevisionNumber + 1,
    ...(input.workspace.currentRevisionId === undefined
      ? {}
      : { parentRevisionId: input.workspace.currentRevisionId }),
    createdByRunId: input.rootRun.id,
    leaseEpoch: input.leaseEpoch,
    objectKey: input.objectKey,
    digest: input.digest,
    createdAt: input.now,
  });
  const workspace = sealEntity("Workspace", {
    ...input.workspace,
    currentRevisionNumber: revision.revisionNumber,
    currentRevisionId: revision.id,
    updatedAt: input.now,
  });
  // 这里仅准备条件写命令；Repository 必须在一个事务中原子比较 revision 与 lease epoch。
  return Object.freeze({
    expectedCurrentRevisionNumber: input.workspace.currentRevisionNumber,
    expectedLeaseEpoch: input.leaseEpoch,
    workspace,
    revision,
  });
}

export function rehydrateWorkspace(snapshot: unknown, thread: Thread, writerRun?: Run): Workspace {
  const raw = recordValue(snapshot, "Workspace");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, thread.tenantId);
  const restoredThreadId = threadId(stringValue(raw, "threadId"));
  domainInvariant(restoredThreadId === thread.id, "OWNERSHIP_MISMATCH", "工作区任务关联无效");
  const currentRevisionNumber = integerValue(raw, "currentRevisionNumber");
  const leaseEpoch = integerValue(raw, "leaseEpoch");
  domainInvariant(
    currentRevisionNumber >= 0 && leaseEpoch >= 0,
    "INVALID_ARGUMENT",
    "工作区版本无效",
  );
  const currentRevision = optionalStringValue(raw, "currentRevisionId");
  domainInvariant(
    (currentRevisionNumber === 0) === (currentRevision === undefined),
    "INVALID_ARGUMENT",
    "工作区当前版本关联无效",
  );
  const writerRaw = raw.writerLease;
  let writerLease: WorkspaceWriterLease | undefined;
  if (writerRaw !== undefined) {
    domainInvariant(writerRun !== undefined, "INVALID_ARGUMENT", "恢复写租约时缺少关联运行");
    const writer = recordValue(writerRaw, "WorkspaceWriterLease");
    const rootRunId = runId(stringValue(writer, "rootRunId"));
    domainInvariant(rootRunId === writerRun.id, "OWNERSHIP_MISMATCH", "写租约运行关联无效");
    assertSameTenant(writerRun.tenantId, restoredTenantId);
    domainInvariant(
      writerRun.threadId === restoredThreadId,
      "OWNERSHIP_MISMATCH",
      "写租约任务关联无效",
    );
    const epoch = integerValue(writer, "epoch");
    domainInvariant(epoch === leaseEpoch && epoch > 0, "INVALID_ARGUMENT", "写租约 epoch 无效");
    writerLease = Object.freeze({
      rootRunId,
      epoch,
      expiresAt: isoTimestamp(stringValue(writer, "expiresAt")),
    });
  }
  return sealEntity("Workspace", {
    id: workspaceId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    threadId: restoredThreadId,
    currentRevisionNumber,
    ...(currentRevision === undefined
      ? {}
      : { currentRevisionId: workspaceRevisionId(currentRevision) }),
    leaseEpoch,
    ...(writerLease === undefined ? {} : { writerLease }),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

export function rehydrateWorkspaceRevision(
  snapshot: unknown,
  workspace: Workspace,
  rootRun: Run,
): WorkspaceRevision {
  const raw = recordValue(snapshot, "WorkspaceRevision");
  assertRunOwnsWorkspace(workspace, rootRun);
  const restoredWorkspaceId = workspaceId(stringValue(raw, "workspaceId"));
  domainInvariant(restoredWorkspaceId === workspace.id, "OWNERSHIP_MISMATCH", "工作区版本关联无效");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, workspace.tenantId);
  const restoredThreadId = threadId(stringValue(raw, "threadId"));
  domainInvariant(
    restoredThreadId === workspace.threadId,
    "OWNERSHIP_MISMATCH",
    "版本任务关联无效",
  );
  const createdByRunId = runId(stringValue(raw, "createdByRunId"));
  domainInvariant(createdByRunId === rootRun.id, "OWNERSHIP_MISMATCH", "版本运行关联无效");
  const revisionNumber = integerValue(raw, "revisionNumber");
  const leaseEpoch = integerValue(raw, "leaseEpoch");
  domainInvariant(revisionNumber > 0 && leaseEpoch > 0, "INVALID_ARGUMENT", "工作区版本序号无效");
  domainInvariant(
    revisionNumber <= workspace.currentRevisionNumber,
    "INVALID_ARGUMENT",
    "工作区版本超出聚合当前版本",
  );
  const restoredRevisionId = workspaceRevisionId(stringValue(raw, "id"));
  if (revisionNumber === workspace.currentRevisionNumber) {
    domainInvariant(
      workspace.currentRevisionId === restoredRevisionId,
      "OWNERSHIP_MISMATCH",
      "工作区当前版本关联无效",
    );
  }
  const parent = optionalStringValue(raw, "parentRevisionId");
  domainInvariant(
    (revisionNumber === 1) === (parent === undefined),
    "INVALID_ARGUMENT",
    "工作区父版本关联无效",
  );
  const objectKey = stringValue(raw, "objectKey");
  domainInvariant(objectKey.trim().length > 0, "INVALID_ARGUMENT", "对象存储键不能为空");
  return sealEntity("WorkspaceRevision", {
    id: restoredRevisionId,
    workspaceId: restoredWorkspaceId,
    tenantId: restoredTenantId,
    threadId: restoredThreadId,
    revisionNumber,
    ...(parent === undefined ? {} : { parentRevisionId: workspaceRevisionId(parent) }),
    createdByRunId,
    leaseEpoch,
    objectKey,
    digest: sha256Digest(stringValue(raw, "digest")),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
  });
}

export type ResourceOrigin = "upload" | "file_source" | "promoted_workspace" | "artifact";
interface ResourceData {
  readonly id: ResourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly origin: ResourceOrigin;
  readonly latestVersionNumber: number;
  readonly latestVersionId?: ResourceVersionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Resource = Entity<"Resource", ResourceData>;

interface ResourceVersionData {
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
export type ResourceVersion = Entity<"ResourceVersion", ResourceVersionData>;

export function createResource(input: {
  readonly id: ResourceId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly origin: ResourceOrigin;
  readonly now: IsoTimestamp;
}): Resource {
  const name = input.name.trim();
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "资源名称长度无效");
  return sealEntity("Resource", {
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
  const version = sealEntity("ResourceVersion", {
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
  const resource = sealEntity("Resource", {
    ...input.resource,
    latestVersionNumber: version.versionNumber,
    latestVersionId: version.id,
    updatedAt: input.now,
  });
  return Object.freeze({ resource, version });
}

export function rehydrateResource(snapshot: unknown, expectedTenantId: TenantId): Resource {
  const raw = recordValue(snapshot, "Resource");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, expectedTenantId);
  const name = stringValue(raw, "name").trim();
  const latestVersionNumber = integerValue(raw, "latestVersionNumber");
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "资源名称长度无效");
  domainInvariant(latestVersionNumber >= 0, "INVALID_ARGUMENT", "资源版本序号无效");
  const latest = optionalStringValue(raw, "latestVersionId");
  domainInvariant(
    (latest === undefined) === (latestVersionNumber === 0),
    "INVALID_ARGUMENT",
    "资源最新版本关联无效",
  );
  return sealEntity("Resource", {
    id: resourceId(stringValue(raw, "id")),
    tenantId: restoredTenantId,
    name,
    origin: enumValue(raw, "origin", [
      "upload",
      "file_source",
      "promoted_workspace",
      "artifact",
    ] as const),
    latestVersionNumber,
    ...(latest === undefined ? {} : { latestVersionId: resourceVersionId(latest) }),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}

export function rehydrateResourceVersion(snapshot: unknown, resource: Resource): ResourceVersion {
  const raw = recordValue(snapshot, "ResourceVersion");
  const restoredResourceId = resourceId(stringValue(raw, "resourceId"));
  domainInvariant(restoredResourceId === resource.id, "OWNERSHIP_MISMATCH", "资源版本关联无效");
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, resource.tenantId);
  const versionNumber = integerValue(raw, "versionNumber");
  const sizeBytes = integerValue(raw, "sizeBytes");
  domainInvariant(versionNumber > 0 && sizeBytes >= 0, "INVALID_ARGUMENT", "资源版本字段无效");
  domainInvariant(
    versionNumber <= resource.latestVersionNumber,
    "INVALID_ARGUMENT",
    "资源版本超出聚合当前版本",
  );
  const restoredVersionId = resourceVersionId(stringValue(raw, "id"));
  if (versionNumber === resource.latestVersionNumber) {
    domainInvariant(
      resource.latestVersionId === restoredVersionId,
      "OWNERSHIP_MISMATCH",
      "资源最新版本关联无效",
    );
  }
  const parent = optionalStringValue(raw, "parentVersionId");
  domainInvariant(
    (versionNumber === 1) === (parent === undefined),
    "INVALID_ARGUMENT",
    "资源父版本关联无效",
  );
  const objectKey = stringValue(raw, "objectKey");
  const mediaType = stringValue(raw, "mediaType");
  domainInvariant(objectKey.trim().length > 0, "INVALID_ARGUMENT", "对象存储键不能为空");
  domainInvariant(mediaType.trim().length > 0, "INVALID_ARGUMENT", "媒体类型不能为空");
  return sealEntity("ResourceVersion", {
    id: restoredVersionId,
    resourceId: restoredResourceId,
    tenantId: restoredTenantId,
    versionNumber,
    ...(parent === undefined ? {} : { parentVersionId: resourceVersionId(parent) }),
    objectKey,
    digest: sha256Digest(stringValue(raw, "digest")),
    mediaType,
    sizeBytes,
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
  });
}

export type ArtifactStatus = "publishing" | "published" | "failed";
interface ArtifactData {
  readonly id: ArtifactId;
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly resourceVersionId: ResourceVersionId;
  readonly replacesArtifactId?: ArtifactId;
  readonly name: string;
  readonly status: ArtifactStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
export type Artifact = Entity<"Artifact", ArtifactData>;

export function createArtifact(input: {
  readonly id: ArtifactId;
  readonly run: Run;
  readonly resourceVersion: ResourceVersion;
  readonly name: string;
  readonly now: IsoTimestamp;
  readonly replaces?: Artifact;
}): Artifact {
  domainInvariant(
    input.run.status === "running",
    "INVALID_STATE_TRANSITION",
    "只有运行中的 Run 可以发布交付物",
  );
  assertSameTenant(input.run.tenantId, input.resourceVersion.tenantId);
  if (input.replaces !== undefined) {
    assertSameTenant(input.replaces.tenantId, input.run.tenantId);
    domainInvariant(
      input.replaces.runId === input.run.id,
      "OWNERSHIP_MISMATCH",
      "被替换交付物不属于当前运行",
    );
    domainInvariant(
      input.id !== input.replaces.id,
      "INVALID_ARGUMENT",
      "修正发布必须使用新的 Artifact ID",
    );
    domainInvariant(
      input.replaces.status === "failed",
      "INVALID_STATE_TRANSITION",
      "只能修正失败的交付物发布",
    );
    domainInvariant(
      input.replaces.resourceVersionId !== input.resourceVersion.id,
      "INVALID_ARGUMENT",
      "修正发布必须绑定新的资源版本",
    );
  }
  const name = input.name.trim();
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "交付物名称长度无效");
  return sealEntity("Artifact", {
    id: input.id,
    tenantId: input.run.tenantId,
    threadId: input.run.threadId,
    runId: input.run.id,
    resourceVersionId: input.resourceVersion.id,
    ...(input.replaces === undefined ? {} : { replacesArtifactId: input.replaces.id }),
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
    failed: [],
    published: [],
  };
  domainInvariant(
    transitions[artifact.status].includes(target),
    "INVALID_STATE_TRANSITION",
    "交付物发布状态转换不被允许",
  );
  return sealEntity("Artifact", { ...artifact, status: target, updatedAt: now });
}

export function rehydrateArtifact(
  snapshot: unknown,
  run: Run,
  resourceVersion: ResourceVersion,
  replaces?: Artifact,
): Artifact {
  const raw = recordValue(snapshot, "Artifact");
  const restoredArtifactId = artifactId(stringValue(raw, "id"));
  const restoredTenantId = tenantId(stringValue(raw, "tenantId"));
  assertSameTenant(restoredTenantId, run.tenantId);
  assertSameTenant(resourceVersion.tenantId, run.tenantId);
  const restoredRunId = runId(stringValue(raw, "runId"));
  domainInvariant(restoredRunId === run.id, "OWNERSHIP_MISMATCH", "交付物运行关联无效");
  const restoredThreadId = threadId(stringValue(raw, "threadId"));
  domainInvariant(restoredThreadId === run.threadId, "OWNERSHIP_MISMATCH", "交付物任务关联无效");
  const restoredVersionId = resourceVersionId(stringValue(raw, "resourceVersionId"));
  domainInvariant(
    restoredVersionId === resourceVersion.id,
    "OWNERSHIP_MISMATCH",
    "交付物资源版本关联无效",
  );
  const replacementId = optionalStringValue(raw, "replacesArtifactId");
  domainInvariant(
    (replacementId === undefined) === (replaces === undefined),
    "INVALID_ARGUMENT",
    "交付物替换关联不完整",
  );
  if (replacementId !== undefined) {
    domainInvariant(replaces !== undefined, "INVALID_ARGUMENT", "恢复修正发布时缺少原交付物");
    domainInvariant(
      artifactId(replacementId) === replaces.id,
      "OWNERSHIP_MISMATCH",
      "被替换交付物关联无效",
    );
    domainInvariant(
      restoredArtifactId !== replaces.id,
      "INVALID_ARGUMENT",
      "修正发布必须使用新的 Artifact ID",
    );
    assertSameTenant(replaces.tenantId, restoredTenantId);
    domainInvariant(
      replaces.runId === restoredRunId,
      "OWNERSHIP_MISMATCH",
      "被替换交付物运行关联无效",
    );
    domainInvariant(replaces.status === "failed", "INVALID_ARGUMENT", "被替换交付物必须是失败状态");
    domainInvariant(
      replaces.resourceVersionId !== restoredVersionId,
      "INVALID_ARGUMENT",
      "修正发布必须绑定新的资源版本",
    );
  }
  const name = stringValue(raw, "name").trim();
  domainInvariant(name.length > 0 && name.length <= 255, "INVALID_ARGUMENT", "交付物名称长度无效");
  return sealEntity("Artifact", {
    id: restoredArtifactId,
    tenantId: restoredTenantId,
    threadId: restoredThreadId,
    runId: restoredRunId,
    resourceVersionId: restoredVersionId,
    ...(replacementId === undefined ? {} : { replacesArtifactId: artifactId(replacementId) }),
    name,
    status: enumValue(raw, "status", ["publishing", "published", "failed"] as const),
    createdAt: isoTimestamp(stringValue(raw, "createdAt")),
    updatedAt: isoTimestamp(stringValue(raw, "updatedAt")),
  });
}
