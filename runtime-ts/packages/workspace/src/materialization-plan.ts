import { Buffer } from "node:buffer";
import { manifestError } from "./errors.js";
import {
  assertWorkspaceManifestIntegrity,
  type WorkspaceContentIdentity,
  type WorkspaceManifest,
  type WorkspaceStableObjectIdentity,
} from "./manifest.js";
import { assertMaterializationRoot, resolveWorkspaceTargetPath } from "./path.js";

export interface PlannedPath {
  readonly relativePath: string;
  readonly targetPath: string;
}

export interface WorkspaceReuseCandidate extends PlannedPath {
  /** 候选只证明摘要与大小相同；执行器仍须验证来源授权和实际内容。 */
  readonly requiresAuthorizationAndIntegrityCheck: true;
}

export interface PlannedWorkspaceFile extends PlannedPath {
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
  /** 同路径工作副本也只是候选；校验失败时必须回退到 object，而不是信任现有字节。 */
  readonly existingTargetCandidate?: WorkspaceReuseCandidate;
  readonly reuseCandidates: readonly WorkspaceReuseCandidate[];
}

export interface WorkspaceMaterializationPlan {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly targetManifestDigest: string;
  readonly previousManifestDigest?: string;
  readonly removeFiles: readonly PlannedPath[];
  readonly removeDirectories: readonly PlannedPath[];
  readonly ensureDirectories: readonly PlannedPath[];
  /** 包含目标清单中的每个文件；候选不可用时一律从该项绑定的 stable object 物化。 */
  readonly materializeFiles: readonly PlannedWorkspaceFile[];
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function directories(paths: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      result.add(segments.slice(0, index).join("/"));
    }
  }
  return result;
}

function plannedPath(root: string, relativePath: string): PlannedPath {
  return Object.freeze({
    relativePath,
    targetPath: resolveWorkspaceTargetPath(root, relativePath),
  });
}

function ascendingPaths(values: Iterable<string>): string[] {
  return [...values].sort(compareUtf8);
}

function ascendingDirectories(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? compareUtf8(left, right) : depth;
  });
}

function descendingDirectories(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => {
    const depth = right.split("/").length - left.split("/").length;
    return depth === 0 ? compareUtf8(left, right) : depth;
  });
}

function sameContent(left: WorkspaceContentIdentity, right: WorkspaceContentIdentity): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

/**
 * 从空目录或前一不可变清单生成确定性差异计划。本函数不访问宿主文件系统、不下载 Blob，
 * reuseCandidates 也绝不代表 Tenant 授权已经通过。
 */
export function planWorkspaceMaterialization(input: {
  readonly root: string;
  readonly target: WorkspaceManifest;
  readonly previous?: WorkspaceManifest;
}): WorkspaceMaterializationPlan {
  const root = assertMaterializationRoot(input.root);
  const target = assertWorkspaceManifestIntegrity(input.target);
  const previous =
    input.previous === undefined ? undefined : assertWorkspaceManifestIntegrity(input.previous);
  manifestError(
    previous === undefined || previous.tenantId === target.tenantId,
    "TENANT_SCOPE_MISMATCH",
    "前后 WorkspaceManifest 不属于同一 Tenant",
  );
  const previousEntries = previous?.entries ?? [];
  const previousByPath = new Map(previousEntries.map((entry) => [entry.path, entry]));
  const targetByPath = new Map(target.entries.map((entry) => [entry.path, entry]));

  const retained = new Set(
    target.entries
      .filter((entry) => {
        const former = previousByPath.get(entry.path);
        return former !== undefined && sameContent(former.content, entry.content);
      })
      .map((entry) => entry.path),
  );
  const oldDirectories = directories(previousEntries.map((entry) => entry.path));
  const targetDirectories = directories(target.entries.map((entry) => entry.path));

  const removeFiles = ascendingPaths(
    previousEntries.filter((entry) => !retained.has(entry.path)).map((entry) => entry.path),
  ).map((path) => plannedPath(root, path));
  const removeDirectories = descendingDirectories(
    [...oldDirectories].filter((directory) => !targetDirectories.has(directory)),
  ).map((path) => plannedPath(root, path));
  const ensureDirectories = ascendingDirectories(
    [...targetDirectories].filter((directory) => !oldDirectories.has(directory)),
  ).map((path) => plannedPath(root, path));

  const materializeFiles = target.entries.map((entry): PlannedWorkspaceFile => {
    const reuseCandidates = previousEntries
      .filter((candidate) => sameContent(candidate.content, entry.content))
      .map((candidate) => candidate.path)
      .sort(compareUtf8)
      .map((path) =>
        Object.freeze({
          ...plannedPath(root, path),
          requiresAuthorizationAndIntegrityCheck: true as const,
        }),
      );
    return Object.freeze({
      ...plannedPath(root, entry.path),
      content: entry.content,
      object: entry.object,
      ...(retained.has(entry.path)
        ? {
            existingTargetCandidate: Object.freeze({
              ...plannedPath(root, entry.path),
              requiresAuthorizationAndIntegrityCheck: true as const,
            }),
          }
        : {}),
      reuseCandidates: Object.freeze(reuseCandidates),
    });
  });

  // targetByPath 参与防御性完整性验证，避免后续重构误把重复路径静默覆盖。
  if (targetByPath.size !== target.entries.length) {
    throw new Error("已验证清单出现不可达的重复路径");
  }
  return Object.freeze({
    schemaVersion: 1,
    root,
    targetManifestDigest: target.digest,
    ...(previous === undefined ? {} : { previousManifestDigest: previous.digest }),
    removeFiles: Object.freeze(removeFiles),
    removeDirectories: Object.freeze(removeDirectories),
    ensureDirectories: Object.freeze(ensureDirectories),
    materializeFiles: Object.freeze(materializeFiles),
  });
}
