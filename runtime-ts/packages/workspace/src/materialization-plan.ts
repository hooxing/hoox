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

export interface WorkspaceExistingTargetCandidate extends PlannedPath {
  /** 候选只证明前一清单声明了相同内容；执行器仍须验证当前字节和来源授权。 */
  readonly requiresAuthorizationAndIntegrityCheck: true;
  readonly content: WorkspaceContentIdentity;
}

export interface PlannedWorkspaceFile extends PlannedPath {
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
  /** 同路径工作副本也只是候选；校验失败时必须回退到 object，而不是信任现有字节。 */
  readonly existingTargetCandidate?: WorkspaceExistingTargetCandidate;
}

export type WorkspaceMaterializationPhases = readonly [
  {
    readonly kind: "verify_existing";
    readonly candidates: readonly WorkspaceExistingTargetCandidate[];
  },
  { readonly kind: "remove_files"; readonly paths: readonly PlannedPath[] },
  { readonly kind: "remove_directories"; readonly paths: readonly PlannedPath[] },
  { readonly kind: "ensure_directories"; readonly paths: readonly PlannedPath[] },
  {
    readonly kind: "materialize_files";
    /** 每项都绑定 stable fallback；verify_existing 未通过时必须写入 fallback。 */
    readonly files: readonly PlannedWorkspaceFile[];
  },
];

export interface WorkspaceMaterializationPlan {
  readonly schemaVersion: 1;
  readonly root: string;
  readonly targetManifestDigest: string;
  readonly previousManifestDigest?: string;
  /** 数组顺序就是执行依赖，执行器不得在 verify_existing 完成前进入任何删除阶段。 */
  readonly phases: WorkspaceMaterializationPhases;
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
 * 同路径保留候选也绝不代表 Tenant 授权或实际内容校验已经通过。
 */
export function planWorkspaceMaterialization(input: {
  readonly root: string;
  readonly target: WorkspaceManifest;
  readonly previous?: WorkspaceManifest;
}): WorkspaceMaterializationPlan {
  const rootInput = input.root;
  const targetInput = input.target;
  const previousInput = input.previous;
  const root = assertMaterializationRoot(rootInput);
  const target = assertWorkspaceManifestIntegrity(targetInput);
  const previous =
    previousInput === undefined ? undefined : assertWorkspaceManifestIntegrity(previousInput);
  manifestError(
    previous === undefined || previous.tenantId === target.tenantId,
    "TENANT_SCOPE_MISMATCH",
    "前后 WorkspaceManifest 不属于同一 Tenant",
  );
  const previousEntries = previous?.entries ?? [];
  const previousByPath = new Map(previousEntries.map((entry) => [entry.path, entry]));

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
    return Object.freeze({
      ...plannedPath(root, entry.path),
      content: entry.content,
      object: entry.object,
      ...(retained.has(entry.path)
        ? {
            existingTargetCandidate: Object.freeze({
              ...plannedPath(root, entry.path),
              requiresAuthorizationAndIntegrityCheck: true as const,
              content: entry.content,
            }),
          }
        : {}),
    });
  });
  const verifyExisting = materializeFiles.flatMap((file) =>
    file.existingTargetCandidate === undefined ? [] : [file.existingTargetCandidate],
  );

  const phases: WorkspaceMaterializationPhases = Object.freeze([
    Object.freeze({ kind: "verify_existing", candidates: Object.freeze(verifyExisting) }),
    Object.freeze({ kind: "remove_files", paths: Object.freeze(removeFiles) }),
    Object.freeze({ kind: "remove_directories", paths: Object.freeze(removeDirectories) }),
    Object.freeze({ kind: "ensure_directories", paths: Object.freeze(ensureDirectories) }),
    Object.freeze({ kind: "materialize_files", files: Object.freeze(materializeFiles) }),
  ]);
  return Object.freeze({
    schemaVersion: 1,
    root,
    targetManifestDigest: target.digest,
    ...(previous === undefined ? {} : { previousManifestDigest: previous.digest }),
    phases,
  });
}
