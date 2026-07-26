export { WorkspaceManifestError, type WorkspaceManifestErrorCode } from "./errors.js";
export {
  createWorkspaceManifest,
  parseWorkspaceManifest,
  WORKSPACE_MANIFEST_SCHEMA_VERSION,
  type WorkspaceContentIdentity,
  type WorkspaceFileEntry,
  type WorkspaceManifest,
  type WorkspaceManifestPolicy,
  type WorkspaceStableObjectIdentity,
} from "./manifest.js";
export {
  type PlannedPath,
  type PlannedWorkspaceFile,
  planWorkspaceMaterialization,
  type WorkspaceExistingTargetCandidate,
  type WorkspaceMaterializationPhases,
  type WorkspaceMaterializationPlan,
} from "./materialization-plan.js";
export {
  assertMaterializationRoot,
  resolveWorkspaceTargetPath,
  workspaceRelativePath,
} from "./path.js";
