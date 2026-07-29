export {
  WorkspaceApplicationError,
  type WorkspaceApplicationErrorCode,
  WorkspaceDependencyError,
  type WorkspaceDependencyResult,
} from "./application-errors.js";
export type {
  SandboxSessionIdentity,
  SandboxWorkspaceEntry,
  SandboxWorkspaceEntryKind,
  SandboxWorkspacePort,
  SandboxWorkspaceSnapshot,
  ValidatedWorkspaceChange,
  WorkspaceCandidateBlob,
  WorkspaceCandidateBlobWritePort,
  WorkspaceCandidateHandoffPort,
  WorkspaceCandidateIdentity,
  WorkspaceExecutionPolicy,
  WorkspaceKnownFailureDisposition,
  WorkspaceOperationBeginResult,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceOperationResult,
  WorkspaceStableAuthorizationReceipt,
  WorkspaceStableBlobReadPort,
  WorkspaceTrustedScope,
  WorkspaceUnknownFact,
} from "./application-ports.js";
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
  type MaterializedWorkspace,
  type MaterializeWorkspaceInput,
  SANDBOX_WORKSPACE_ROOT,
  WorkspaceMaterializer,
  type WorkspaceMaterializerOptions,
} from "./materializer.js";
export {
  assertMaterializationRoot,
  resolveWorkspaceTargetPath,
  workspaceRelativePath,
} from "./path.js";
export {
  type PublishWorkspaceInput,
  WorkspacePublisher,
  type WorkspacePublisherOptions,
} from "./publisher.js";
