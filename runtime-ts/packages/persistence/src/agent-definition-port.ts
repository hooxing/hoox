import type { AgentAvailability, AgentRevisionContent } from "@hoox/domain";

export interface StoredAgentDefinition {
  readonly id: string;
  readonly status: "draft" | "published" | "disabled" | "revoked";
  readonly generation: number;
  readonly availability: AgentAvailability;
  readonly currentRevisionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface StoredAgentRevision {
  readonly id: string;
  readonly definitionId: string;
  readonly revision: number;
  readonly status: "draft" | "published" | "revoked";
  readonly content: AgentRevisionContent;
  readonly digest: string;
  readonly createdAt: string;
  readonly createdBy: string;
}
export interface CreateAgentDefinitionDraftInput {
  readonly actorUserId: string;
  readonly id: string;
  readonly availability: AgentAvailability;
  readonly content: AgentRevisionContent;
  readonly revisionId: string;
  readonly idempotencyKey: string;
  readonly expectedGeneration: number;
}
export interface CreateAgentRevisionDraftInput {
  readonly actorUserId: string;
  readonly definitionId: string;
  readonly revisionId: string;
  readonly content: AgentRevisionContent;
  readonly idempotencyKey: string;
  readonly expectedGeneration: number;
}
export interface AgentDefinitionCommandInput {
  readonly actorUserId: string;
  readonly definitionId: string;
  readonly idempotencyKey: string;
  readonly expectedGeneration: number;
}
export interface PublishAgentRevisionInput extends AgentDefinitionCommandInput {
  readonly revisionId: string;
}
export interface RevokeAgentRevisionInput extends PublishAgentRevisionInput {
  readonly reason: string;
}
export interface AgentDefinitionRepositoryPort {
  createDraft(input: CreateAgentDefinitionDraftInput): Promise<{
    readonly definition: StoredAgentDefinition;
    readonly revision: StoredAgentRevision;
  }>;
  createDraftRevision(input: CreateAgentRevisionDraftInput): Promise<StoredAgentRevision>;
  publish(input: PublishAgentRevisionInput): Promise<StoredAgentDefinition>;
  deactivate(input: AgentDefinitionCommandInput): Promise<StoredAgentDefinition>;
  revoke(input: RevokeAgentRevisionInput): Promise<StoredAgentDefinition>;
  listAvailable(tenantId: string): Promise<
    readonly {
      readonly definition: StoredAgentDefinition;
      readonly revision: StoredAgentRevision;
    }[]
  >;
  readCurrentPublished(
    tenantId: string,
    definitionId: string,
  ): Promise<StoredAgentRevision | undefined>;
  readRevisionById(tenantId: string, revisionId: string): Promise<StoredAgentRevision | undefined>;
}

export interface SetAgentAvailabilityInput extends AgentDefinitionCommandInput {
  readonly availability: AgentAvailability;
}

export interface StoredAgentRevisionSummary extends Omit<StoredAgentRevision, "content"> {
  readonly displayName: string;
}

export interface AgentDefinitionAdminRepositoryPort
  extends Pick<
    AgentDefinitionRepositoryPort,
    "createDraft" | "createDraftRevision" | "publish" | "deactivate" | "revoke"
  > {
  listDefinitions(actorUserId: string): Promise<{
    readonly canManage: boolean;
    readonly builtinToolLimit: readonly string[];
    readonly items: readonly {
      readonly definition: StoredAgentDefinition;
      readonly revision?: StoredAgentRevisionSummary;
    }[];
  }>;
  listRevisions(
    actorUserId: string,
    definitionId: string,
  ): Promise<
    | {
        readonly definition: StoredAgentDefinition;
        readonly items: readonly StoredAgentRevisionSummary[];
      }
    | undefined
  >;
  readAdminRevision(
    actorUserId: string,
    definitionId: string,
    revisionId: string,
  ): Promise<StoredAgentRevision | undefined>;
  setAvailability(input: SetAgentAvailabilityInput): Promise<StoredAgentDefinition>;
}
