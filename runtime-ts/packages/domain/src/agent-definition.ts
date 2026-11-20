import { sealEntity, type Entity } from "./entity.js";
import { domainInvariant } from "./errors.js";
import { isoTimestamp, sha256Digest, type Sha256Digest, type TenantId } from "./ids.js";

export type AgentDefinitionStatus = "draft" | "published" | "disabled" | "revoked";
export type AgentRevisionStatus = "draft" | "published" | "revoked";
export type AgentAvailability =
  | { readonly mode: "all_tenants" }
  | { readonly mode: "selected_tenants"; readonly tenantIds: readonly TenantId[] };

/** Revision 内容保持 JSON 兼容；规范化边界负责拒绝凭据与请求级动态值。 */
export interface AgentRevisionContent {
  readonly displayName: string;
  readonly description: string;
  readonly avatarRef?: string;
  readonly welcomeMessage?: string;
  readonly suggestedQuestions: readonly string[];
  readonly operatorInstructions: string;
  readonly replyLanguage: string;
  readonly model:
    | { readonly mode: "platform_default" }
    | {
        readonly mode: "pinned";
        readonly providerRevisionId: string;
        readonly modelId: string;
      };
  readonly builtinTools: readonly string[];
  readonly externalTools: readonly { readonly kind: "mcp" | "http"; readonly versionId: string }[];
  readonly clientTools: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
  }[];
  readonly toolCallingMode: "native" | "ptc";
  readonly skillVersions: readonly { readonly skillId: string; readonly version: string }[];
  readonly includeTenantSkills: boolean;
  readonly sandboxTemplateId?: string;
  readonly sandboxIdleAction: "pause" | "kill";
  readonly longTermMemoryEnabled: boolean;
}

export interface AgentDefinitionData {
  readonly id: string;
  readonly status: AgentDefinitionStatus;
  readonly generation: number;
  readonly availability: AgentAvailability;
  readonly currentRevisionId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export type AgentDefinition = Entity<"AgentDefinition", AgentDefinitionData>;
export interface AgentRevisionData {
  readonly id: string;
  readonly definitionId: string;
  readonly revision: number;
  readonly status: AgentRevisionStatus;
  readonly content: AgentRevisionContent;
  readonly digest: Sha256Digest;
  readonly createdAt: string;
  readonly createdBy: string;
}
export type AgentRevision = Entity<"AgentRevision", AgentRevisionData>;

const instructionDynamicValue = /\$\{[^}]+\}|\{\{[^}]+\}\}/u;
function exactKeys(value: unknown, allowed: readonly string[], field: string): void {
  domainInvariant(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_ARGUMENT",
    `${field} 格式无效`,
  );
  domainInvariant(
    Object.keys(value).every((key) => allowed.includes(key)),
    "INVALID_ARGUMENT",
    `${field} 含有未声明字段`,
  );
}
function nonempty(value: string, field: string, maxBytes: number): void {
  domainInvariant(
    value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= maxBytes,
    "INVALID_ARGUMENT",
    `${field} 长度无效`,
  );
}
export function validateAgentRevisionContent(value: AgentRevisionContent): AgentRevisionContent {
  exactKeys(
    value,
    [
      "displayName",
      "description",
      "avatarRef",
      "welcomeMessage",
      "suggestedQuestions",
      "operatorInstructions",
      "replyLanguage",
      "model",
      "builtinTools",
      "externalTools",
      "clientTools",
      "toolCallingMode",
      "skillVersions",
      "includeTenantSkills",
      "sandboxTemplateId",
      "sandboxIdleAction",
      "longTermMemoryEnabled",
    ],
    "AgentRevision",
  );
  domainInvariant(
    value.model.mode === "platform_default" || value.model.mode === "pinned",
    "INVALID_ARGUMENT",
    "Agent 模型模式无效",
  );
  exactKeys(
    value.model,
    value.model.mode === "platform_default" ? ["mode"] : ["mode", "providerRevisionId", "modelId"],
    "AgentRevision model",
  );
  for (const item of value.externalTools)
    exactKeys(item, ["kind", "versionId"], "AgentRevision external tool");
  for (const item of value.clientTools)
    exactKeys(item, ["name", "description", "inputSchema"], "AgentRevision client tool");
  for (const item of value.skillVersions)
    exactKeys(item, ["skillId", "version"], "AgentRevision Skill");
  nonempty(value.displayName, "displayName", 200);
  nonempty(value.description, "description", 2048);
  nonempty(value.operatorInstructions, "operatorInstructions", 32768);
  nonempty(value.replyLanguage, "replyLanguage", 100);
  domainInvariant(
    !instructionDynamicValue.test(value.operatorInstructions),
    "INVALID_ARGUMENT",
    "Operator 指令不得包含模板变量",
  );
  domainInvariant(
    value.suggestedQuestions.length <= 12 && value.builtinTools.length <= 64,
    "INVALID_ARGUMENT",
    "Agent 能力数量超出限制",
  );
  domainInvariant(
    value.suggestedQuestions.every(
      (item) => item.trim().length > 0 && new TextEncoder().encode(item).byteLength <= 500,
    ) &&
      value.builtinTools.every((item) => /^[a-z][a-z0-9_]{0,99}$/u.test(item)) &&
      value.externalTools.length <= 64 &&
      value.clientTools.length <= 64 &&
      value.skillVersions.length <= 64,
    "INVALID_ARGUMENT",
    "Agent Revision 子项格式或数量无效",
  );
  domainInvariant(
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65_536,
    "INVALID_ARGUMENT",
    "Agent Revision 总大小超出限制",
  );
  domainInvariant(
    value.model.mode === "platform_default" ||
      (value.model.providerRevisionId.length > 0 && value.model.modelId.length > 0),
    "INVALID_ARGUMENT",
    "模型引用无效",
  );
  return Object.freeze({
    ...value,
    suggestedQuestions: Object.freeze([...value.suggestedQuestions]),
    builtinTools: Object.freeze([...value.builtinTools]),
    externalTools: Object.freeze(value.externalTools.map((item) => Object.freeze({ ...item }))),
    clientTools: Object.freeze(value.clientTools.map((item) => Object.freeze({ ...item }))),
    skillVersions: Object.freeze(value.skillVersions.map((item) => Object.freeze({ ...item }))),
  });
}
export function createAgentDefinition(input: AgentDefinitionData): AgentDefinition {
  domainInvariant(
    /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(input.id),
    "INVALID_ARGUMENT",
    "AgentDefinition ID 格式无效",
  );
  isoTimestamp(input.createdAt);
  isoTimestamp(input.updatedAt);
  domainInvariant(
    ["draft", "published", "disabled", "revoked"].includes(input.status),
    "INVALID_ARGUMENT",
    "AgentDefinition 状态无效",
  );
  domainInvariant(
    input.availability.mode === "all_tenants" || input.availability.mode === "selected_tenants",
    "INVALID_ARGUMENT",
    "Agent 可用范围模式无效",
  );
  domainInvariant(
    Number.isSafeInteger(input.generation) && input.generation >= 0,
    "INVALID_ARGUMENT",
    "Agent generation 无效",
  );
  if (input.availability.mode === "selected_tenants") {
    domainInvariant(
      input.availability.tenantIds.length > 0 &&
        new Set(input.availability.tenantIds).size === input.availability.tenantIds.length,
      "INVALID_ARGUMENT",
      "Agent Tenant 范围无效",
    );
  }
  return sealEntity("AgentDefinition", {
    ...input,
    availability:
      input.availability.mode === "selected_tenants"
        ? Object.freeze({
            mode: input.availability.mode,
            tenantIds: Object.freeze([...input.availability.tenantIds]),
          })
        : Object.freeze({ mode: input.availability.mode }),
  });
}
export function createAgentRevision(
  input: Omit<AgentRevisionData, "digest"> & { readonly digest: string },
): AgentRevision {
  return sealEntity("AgentRevision", {
    ...input,
    content: validateAgentRevisionContent(input.content),
    digest: sha256Digest(input.digest),
  });
}

export function publishAgentRevision(input: {
  readonly definition: AgentDefinition;
  readonly revision: AgentRevision;
  readonly expectedGeneration: number;
  readonly now: string;
}): { readonly definition: AgentDefinition; readonly revision: AgentRevision } {
  domainInvariant(
    input.definition.generation === input.expectedGeneration,
    "VERSION_CONFLICT",
    "Agent generation 已变化",
  );
  domainInvariant(
    input.revision.definitionId === input.definition.id && input.revision.status === "draft",
    "INVALID_STATE_TRANSITION",
    "只能发布所属 Agent 的草稿 Revision",
  );
  domainInvariant(
    input.definition.status !== "revoked",
    "INVALID_STATE_TRANSITION",
    "已撤销 AgentDefinition 不能发布",
  );
  const definition = createAgentDefinition({
    ...input.definition,
    status: "published",
    generation: input.definition.generation + 1,
    currentRevisionId: input.revision.id,
    updatedAt: input.now,
  });
  const revision = createAgentRevision({
    ...input.revision,
    status: "published",
    digest: input.revision.digest,
  });
  return Object.freeze({ definition, revision });
}

export function deactivateAgentDefinition(input: {
  readonly definition: AgentDefinition;
  readonly expectedGeneration: number;
  readonly now: string;
}): AgentDefinition {
  domainInvariant(
    input.definition.generation === input.expectedGeneration,
    "VERSION_CONFLICT",
    "Agent generation 已变化",
  );
  domainInvariant(
    input.definition.status === "published",
    "INVALID_STATE_TRANSITION",
    "只有已发布 AgentDefinition 可以停用",
  );
  return createAgentDefinition({
    ...input.definition,
    status: "disabled",
    generation: input.definition.generation + 1,
    updatedAt: input.now,
  });
}

export function revokeAgentRevision(input: {
  readonly definition: AgentDefinition;
  readonly revision: AgentRevision;
  readonly expectedGeneration: number;
  readonly now: string;
}): { readonly definition: AgentDefinition; readonly revision: AgentRevision } {
  domainInvariant(
    input.definition.generation === input.expectedGeneration,
    "VERSION_CONFLICT",
    "Agent generation 已变化",
  );
  domainInvariant(
    input.revision.definitionId === input.definition.id && input.revision.status === "published",
    "INVALID_STATE_TRANSITION",
    "只能撤销所属 Agent 的已发布 Revision",
  );
  const isCurrent = input.definition.currentRevisionId === input.revision.id;
  const definition = createAgentDefinition({
    ...input.definition,
    status: isCurrent ? "revoked" : input.definition.status,
    generation: input.definition.generation + 1,
    updatedAt: input.now,
  });
  const revision = createAgentRevision({
    ...input.revision,
    status: "revoked",
    digest: input.revision.digest,
  });
  return Object.freeze({ definition, revision });
}
