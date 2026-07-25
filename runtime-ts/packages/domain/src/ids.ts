import { domainInvariant } from "./errors.js";

declare const brand: unique symbol;
export type Branded<T, Name extends string> = T & { readonly [brand]: Name };

export type UserId = Branded<string, "UserId">;
export type TenantId = Branded<string, "TenantId">;
export type MembershipId = Branded<string, "MembershipId">;
export type ThreadId = Branded<string, "ThreadId">;
export type RunId = Branded<string, "RunId">;
export type PlanId = Branded<string, "PlanId">;
export type PlanStepId = Branded<string, "PlanStepId">;
export type WorkspaceId = Branded<string, "WorkspaceId">;
export type WorkspaceRevisionId = Branded<string, "WorkspaceRevisionId">;
export type ResourceId = Branded<string, "ResourceId">;
export type ResourceVersionId = Branded<string, "ResourceVersionId">;
export type ArtifactId = Branded<string, "ArtifactId">;
export type SandboxSessionId = Branded<string, "SandboxSessionId">;
export type AgentThreadId = Branded<string, "AgentThreadId">;
export type IsoTimestamp = Branded<string, "IsoTimestamp">;
export type Sha256Digest = Branded<string, "Sha256Digest">;

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

function toId<Name extends string>(value: string, _name: Name): Branded<string, Name> {
  domainInvariant(idPattern.test(value), "INVALID_ARGUMENT", "ID 格式无效");
  return value as Branded<string, Name>;
}

export const userId = (value: string): UserId => toId(value, "UserId");
export const tenantId = (value: string): TenantId => toId(value, "TenantId");
export const membershipId = (value: string): MembershipId => toId(value, "MembershipId");
export const threadId = (value: string): ThreadId => toId(value, "ThreadId");
export const runId = (value: string): RunId => toId(value, "RunId");
export const planId = (value: string): PlanId => toId(value, "PlanId");
export const planStepId = (value: string): PlanStepId => toId(value, "PlanStepId");
export const workspaceId = (value: string): WorkspaceId => toId(value, "WorkspaceId");
export const workspaceRevisionId = (value: string): WorkspaceRevisionId =>
  toId(value, "WorkspaceRevisionId");
export const resourceId = (value: string): ResourceId => toId(value, "ResourceId");
export const resourceVersionId = (value: string): ResourceVersionId =>
  toId(value, "ResourceVersionId");
export const artifactId = (value: string): ArtifactId => toId(value, "ArtifactId");
export const sandboxSessionId = (value: string): SandboxSessionId =>
  toId(value, "SandboxSessionId");
export const agentThreadId = (value: string): AgentThreadId => toId(value, "AgentThreadId");

export function isoTimestamp(value: string): IsoTimestamp {
  domainInvariant(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) &&
      !Number.isNaN(Date.parse(value)),
    "INVALID_ARGUMENT",
    "时间戳必须是 UTC ISO 8601 格式",
  );
  return value as IsoTimestamp;
}

export function sha256Digest(value: string): Sha256Digest {
  domainInvariant(/^[a-f0-9]{64}$/u.test(value), "INVALID_ARGUMENT", "摘要必须是 SHA-256");
  return value as Sha256Digest;
}
