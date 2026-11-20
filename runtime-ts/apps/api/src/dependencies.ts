import type { ScheduledTaskManagementPort } from "@hoox/automation";
import type { InstallationRepository } from "@hoox/identity";
import type { BlobStore } from "@hoox/persistence/blob";
import type {
  CoreRepositories,
  PgApiKeyRepository,
  PgWebhookRepository,
  PersonalizationSettingsPort,
  RunExperienceReadPort,
  TeamCollaborationPort,
  ThreadContextReadPort,
  ThreadContinuityReadPort,
  ThreadForkPort,
} from "@hoox/persistence/postgres";
import type { ModelWireTraceReadPort } from "@hoox/persistence/thread";
import type {
  HistoryFileLibraryService,
  HistoryFilesystemCatalog,
  ResourceAttachmentResolverPort,
  ResourceFilesystemCapabilityCodec,
  ResourceFilesystemCatalog,
  ResourceUploadPort,
} from "@hoox/resource";
import type { SkillCenterService, SkillContentStore, SkillFilesystemCatalog } from "@hoox/skill";
import type { WebhookSecretCipher } from "@hoox/persistence/postgres";
import type { ApiCreateCapability } from "./capabilities.js";
import type { EmbeddedIdentityAuthService } from "./embedded-identity-auth.js";
import type { LocalAccountAuthService } from "./local-account-auth.js";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  ReadinessPort,
  RenamePersonalThreadCommandPort,
  ThreadCursorCodec,
} from "./ports.js";

export interface ApiDependencies {
  readonly auth: AuthContextResolver;
  readonly apiKeys?: PgApiKeyRepository;
  readonly webhooks?: PgWebhookRepository;
  readonly webhookCipher?: WebhookSecretCipher;
  readonly localAccounts?: LocalAccountAuthService;
  readonly localAccountPasswordRoutes?: boolean;
  readonly embeddedIdentity?: EmbeddedIdentityAuthService;
  readonly demoAdminUserId?: string;
  readonly installation?: Readonly<{
    repository: InstallationRepository;
    administratorAccounts: LocalAccountAuthService;
    runtimeEnvironment: string;
    setupToken?: string;
  }>;
  readonly repositories: CoreRepositories;
  readonly createCapability?: ApiCreateCapability;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly renamePersonalThread: RenamePersonalThreadCommandPort;
  readonly cursorCodec: ThreadCursorCodec;
  readonly readiness: ReadinessPort;
  readonly clock: ApiClock;
  readonly ids: ApiIdGenerator;
  readonly experience?: RunExperienceReadPort;
  readonly modelWireTraces?: ModelWireTraceReadPort;
  readonly blobs?: BlobStore;
  readonly threadContext?: ThreadContextReadPort;
  readonly threadContinuity?: ThreadContinuityReadPort;
  readonly teamCollaboration?: TeamCollaborationPort;
  readonly personalizations?: PersonalizationSettingsPort;
  readonly scheduledTasks?: ScheduledTaskManagementPort;
  readonly threadForks?: ThreadForkPort;
  readonly resourceUploads?: ResourceUploadPort;
  readonly resourceAttachments?: ResourceAttachmentResolverPort;
  readonly historyFiles?: HistoryFileLibraryService;
  readonly resourceFilesystem?: Readonly<{
    catalog: ResourceFilesystemCatalog;
    capabilities: ResourceFilesystemCapabilityCodec;
    history?: HistoryFilesystemCatalog;
    skills?: Readonly<{
      catalog: SkillFilesystemCatalog;
      contents: SkillContentStore;
    }>;
  }>;
  readonly skillCenter?: SkillCenterService;
}
