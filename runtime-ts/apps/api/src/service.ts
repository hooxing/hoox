import { createHash } from "node:crypto";
import {
  createRun,
  createThread,
  DEFAULT_AGENT_DEFINITION_ID,
  createWorkspace,
  DomainError,
  type ApiKeyScope,
  resourceId,
  resourceVersionId,
  rehydrateThread,
  runId,
  tenantId,
  threadId,
} from "@hoox/domain";
import type {
  CoreRepositories,
  AgentDefinitionRepositoryPort,
  TenantBundle,
  TenantScope,
  ThreadListCursor,
} from "@hoox/persistence/postgres";
import type {
  AvailableAgentDto,
  CreateThreadInputRequest,
  RunDto,
  ThreadDto,
  ThreadInputReceiptDto,
  ThreadPageDto,
} from "@hoox/protocol";
import { MAX_RUN_INPUT_UTF8_BYTES } from "@hoox/protocol";
import {
  appendFileReferences,
  validFileSelection,
  type FileReference,
} from "@hoox/protocol/file-references";
import {
  cancelScopedRun,
  PersistenceError,
  type RunExperienceReadPort,
} from "@hoox/persistence/postgres";
import { toRunDto, toThreadDto } from "@hoox/protocol-mapper";
import {
  appendAttachmentsToLatestUserPrompt,
  type ResourceAttachmentResolverPort,
} from "@hoox/resource";
import {
  resolveExplicitSkillInvocation,
  SkillRuntimeError,
  type ExplicitSkillInvocation,
} from "@hoox/skill";
import type { ApiCreateCapability } from "./capabilities.js";
import { isApiKeyToken, type ApiKeyAuthenticationPort, type ApiKeyPrincipal } from "@hoox/identity";
import { InvalidThreadCursorError } from "./cursor.js";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  RenamePersonalThreadCommandPort,
  AuthPrincipal,
  TenantSelector,
  ThreadCursorCodec,
} from "./ports.js";

export type ApiFailureKind =
  | "bad_request"
  | "payload_too_large"
  | "end_user_required"
  | "idempotency_conflict"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "invalid_state"
  | "unsupported_media_type"
  | "dependency_unavailable"
  | "internal";

export class ApiFailure extends Error {
  constructor(readonly kind: ApiFailureKind) {
    super(kind);
    this.name = "ApiFailure";
  }
}

interface AuthContext {
  readonly principal: AuthPrincipal;
  readonly scope: TenantScope;
  readonly tenant: TenantBundle;
  readonly apiKey?: Readonly<{ readonly id: string; readonly scopes: readonly ApiKeyScope[] }>;
}

interface ServiceDependencies {
  readonly experience?: RunExperienceReadPort;
  readonly auth: AuthContextResolver;
  readonly apiKeys?: ApiKeyAuthenticationPort;
  readonly repositories: CoreRepositories;
  readonly agentDefinitions?: Pick<
    AgentDefinitionRepositoryPort,
    "listAvailable" | "readVisibleCurrent"
  >;
  readonly createCapability?: ApiCreateCapability;
  readonly archiveThread: ArchiveThreadCommandPort;
  readonly renamePersonalThread: RenamePersonalThreadCommandPort;
  readonly cursorCodec: ThreadCursorCodec;
  readonly clock: ApiClock;
  readonly ids: ApiIdGenerator;
  readonly resourceAttachments?: ResourceAttachmentResolverPort;
}

function commandHash(operation: string, value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, value]))
    .digest("hex");
}

function mapDomainFailure(error: unknown): never {
  if (!(error instanceof DomainError)) throw error;
  switch (error.code) {
    case "INVALID_ARGUMENT":
      throw new ApiFailure("bad_request");
    case "NOT_AUTHORIZED":
    case "OWNERSHIP_MISMATCH":
      throw new ApiFailure("not_found");
    case "INVALID_STATE_TRANSITION":
      throw new ApiFailure("invalid_state");
    case "VERSION_CONFLICT":
      throw new ApiFailure("conflict");
  }
}

export class ApiService {
  constructor(private readonly dependencies: ServiceDependencies) {}

  async authenticate(
    authorization: string | undefined,
    requestId: string,
    tenantSelector: TenantSelector = Object.freeze({ kind: "absent" }),
    options: {
      readonly endUserId?: string | undefined;
      readonly requiredScope?: ApiKeyScope | undefined;
    } = {},
  ): Promise<AuthContext> {
    const bearer = authorization?.match(/^Bearer ([^\s]+)$/u)?.[1];
    let principal: AuthPrincipal | undefined;
    let apiKeyPrincipal: ApiKeyPrincipal | undefined;
    if (bearer?.startsWith("hoox_sk_")) {
      if (!isApiKeyToken(bearer) || this.dependencies.apiKeys === undefined) {
        throw new ApiFailure("unauthorized");
      }
      const credential = await this.dependencies.apiKeys.authenticateKey({
        token: bearer,
        now: this.dependencies.clock.now(),
      });
      if (credential === undefined) throw new ApiFailure("unauthorized");
      apiKeyPrincipal = credential;
      principal = {
        userId: credential.userId,
        kind: "integration",
        tenantId: credential.tenantId,
        apiKey: { id: credential.apiKeyId, scopes: credential.scopes },
      };
    } else {
      principal = await this.dependencies.auth.resolve({ authorization, requestId });
    }
    if (principal === undefined) throw new ApiFailure("unauthorized");
    if (options.endUserId !== undefined) {
      if (
        apiKeyPrincipal === undefined ||
        options.requiredScope === undefined ||
        !apiKeyPrincipal.scopes.includes("end-users:represent")
      ) {
        throw new ApiFailure("forbidden");
      }
    }
    if (tenantSelector.kind === "invalid") throw new ApiFailure("bad_request");
    let selectedTenantId = principal.tenantId;
    if (tenantSelector.kind === "selected") {
      if (principal.apiKey !== undefined && principal.tenantId !== tenantSelector.value) {
        throw new ApiFailure("not_found");
      }
      try {
        selectedTenantId = tenantId(tenantSelector.value);
      } catch {
        throw new ApiFailure("bad_request");
      }
    } else if (selectedTenantId === undefined) {
      throw new ApiFailure("bad_request");
    }
    // 凭据只证明 User 身份；X-Tenant-Id 是候选 scope，Repository 会用 Membership 与 RLS 复核。
    let scope = { tenantId: selectedTenantId, userId: principal.userId };
    let tenant = await this.dependencies.repositories.tenants.get(scope);
    // 凭据有效但成员关系无效时统一为不存在，不能成为租户成员枚举接口。
    if (tenant === undefined) throw new ApiFailure("not_found");
    if (
      principal.apiKey !== undefined &&
      options.requiredScope !== undefined &&
      !principal.apiKey.scopes.includes(options.requiredScope)
    ) {
      throw new ApiFailure("forbidden");
    }
    if (options.endUserId !== undefined && apiKeyPrincipal !== undefined) {
      const mapper = this.dependencies.apiKeys;
      if (mapper?.mapEndUser === undefined) throw new ApiFailure("dependency_unavailable");
      const mapped = await mapper.mapEndUser({
        principal: apiKeyPrincipal,
        externalId: options.endUserId,
        now: this.dependencies.clock.now(),
      });
      if (mapped === "disabled") throw new ApiFailure("forbidden");
      if (mapped === undefined) throw new ApiFailure("unauthorized");
      principal = {
        ...principal,
        kind: "end_user",
        userId: mapped.userId,
        tenantId: mapped.tenantId,
      };
      scope = { tenantId: mapped.tenantId, userId: mapped.userId };
      tenant = await this.dependencies.repositories.tenants.get(scope);
      if (tenant === undefined) throw new ApiFailure("not_found");
    }
    return {
      principal,
      scope,
      tenant,
      ...(principal.apiKey === undefined ? {} : { apiKey: principal.apiKey }),
    };
  }

  async listAvailableAgents(auth: AuthContext): Promise<readonly AvailableAgentDto[]> {
    const repository = this.dependencies.agentDefinitions;
    if (repository === undefined) throw new ApiFailure("dependency_unavailable");
    const available = await repository.listAvailable(auth.scope.tenantId);
    return available.map(({ definition, revision }) => ({
      id: definition.id,
      displayName: revision.content.displayName,
      description: revision.content.description,
      ...(revision.content.avatarRef === undefined
        ? {}
        : { avatarRef: revision.content.avatarRef }),
      ...(revision.content.welcomeMessage === undefined
        ? {}
        : { welcomeMessage: revision.content.welcomeMessage }),
      suggestedQuestions: [...revision.content.suggestedQuestions],
    }));
  }

  async createThread(
    auth: AuthContext,
    title: string,
    idempotencyKey: string,
    requestedAgentDefinitionId?: string,
  ): Promise<ThreadDto> {
    try {
      const capability = this.dependencies.createCapability;
      if (capability === undefined) throw new ApiFailure("not_found");
      const agentDefinitionId = requestedAgentDefinitionId ?? DEFAULT_AGENT_DEFINITION_ID;
      // 省略选择器时保留升级前的内建默认 Agent 路径；只有显式选择才经过目录可见性校验。
      if (requestedAgentDefinitionId !== undefined) {
        const agentRepository = this.dependencies.agentDefinitions;
        if (agentRepository === undefined) throw new ApiFailure("dependency_unavailable");
        const selection = await agentRepository.readVisibleCurrent(
          auth.scope.tenantId,
          agentDefinitionId,
        );
        if (selection === undefined) throw new ApiFailure("not_found");
        if (selection.revision === undefined) {
          throw new PersistenceError(
            "AGENT_REVISION_UNAVAILABLE",
            "Agent 当前没有可用的已发布 Revision",
          );
        }
      }
      const now = this.dependencies.clock.now();
      const defaultThread = createThread({
        id: this.dependencies.ids.thread(),
        tenant: auth.tenant.tenant,
        user: auth.tenant.user,
        membership: auth.tenant.membership,
        title,
        now,
      });
      const thread = rehydrateThread(
        { ...defaultThread, agentDefinitionId },
        auth.tenant.tenant,
        auth.tenant.user,
        auth.tenant.membership,
      );
      const workspace = createWorkspace({
        id: this.dependencies.ids.workspace(),
        thread,
        now,
      });
      const result = await capability.threadCreation.createThread({
        scope: auth.scope,
        tenant: auth.tenant.tenant,
        user: auth.tenant.user,
        membership: auth.tenant.membership,
        thread,
        workspace,
        idempotency: {
          key: idempotencyKey,
          requestHash: commandHash(
            "thread.create",
            agentDefinitionId === DEFAULT_AGENT_DEFINITION_ID
              ? { title: thread.title }
              : { title: thread.title, agentDefinitionId },
          ),
        },
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("idempotency_conflict");
      if (result.outcome === "parent_inactive" || result.outcome === "not_authorized") {
        throw new ApiFailure("not_found");
      }
      return toThreadDto(result.entity);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async getThread(auth: AuthContext, rawThreadId: string): Promise<ThreadDto> {
    const entity = await this.dependencies.repositories.threads.get(
      auth.scope,
      threadId(rawThreadId),
    );
    if (entity === undefined) throw new ApiFailure("not_found");
    return toThreadDto(entity.entity);
  }

  async listThreads(
    auth: AuthContext,
    input: { readonly cursor?: string; readonly limit?: number },
  ): Promise<ThreadPageDto> {
    let cursor: ThreadListCursor | undefined;
    try {
      cursor =
        input.cursor === undefined
          ? undefined
          : this.dependencies.cursorCodec.decode(auth.scope, input.cursor);
    } catch (error) {
      if (error instanceof InvalidThreadCursorError) throw new ApiFailure("bad_request");
      throw error;
    }
    const page = await this.dependencies.repositories.threads.list(auth.scope, {
      limit: input.limit ?? 20,
      ...(cursor === undefined ? {} : { cursor }),
    });
    const nextCursor =
      page.nextCursor === undefined
        ? undefined
        : this.dependencies.cursorCodec.encode(auth.scope, page.nextCursor);
    return {
      items: page.items.map(({ entity }) => toThreadDto(entity)),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async renamePersonalThread(
    auth: AuthContext,
    rawThreadId: string,
    rawTitle: string,
  ): Promise<ThreadDto> {
    if (auth.tenant.tenant.kind !== "personal") throw new ApiFailure("not_found");
    const title = rawTitle.trim();
    if (title.length === 0 || title.length > 200) throw new ApiFailure("bad_request");
    try {
      const result = await this.dependencies.renamePersonalThread.renamePersonalThread({
        scope: auth.scope,
        threadId: threadId(rawThreadId),
        title,
      });
      if (result.outcome !== "renamed") throw new ApiFailure("not_found");
      return toThreadDto(result.entity);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async archiveThread(auth: AuthContext, rawThreadId: string): Promise<ThreadDto> {
    try {
      const result = await this.dependencies.archiveThread.archiveThread({
        scope: auth.scope,
        threadId: threadId(rawThreadId),
      });
      if (result.outcome === "not_authorized" || result.outcome === "not_found") {
        throw new ApiFailure("not_found");
      }
      if (result.outcome !== "archived" && result.outcome !== "already_archived") {
        throw new ApiFailure("internal");
      }
      return toThreadDto(result.entity);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async createRun(
    auth: AuthContext,
    rawThreadId: string,
    inputText: string,
    idempotencyKey: string,
    structuredSkillInvocation?: { readonly skill: string; readonly args?: string },
  ): Promise<RunDto> {
    try {
      const capability = this.dependencies.createCapability;
      if (capability === undefined) throw new ApiFailure("not_found");
      // JavaScript 字符串长度是 UTF-16 code unit，不能作为持久输入的配额依据。
      if (
        inputText.trim().length === 0 ||
        Buffer.byteLength(inputText, "utf8") > MAX_RUN_INPUT_UTF8_BYTES
      ) {
        throw new ApiFailure("bad_request");
      }
      const thread = await this.dependencies.repositories.threads.get(
        auth.scope,
        threadId(rawThreadId),
      );
      if (thread === undefined) throw new ApiFailure("not_found");
      const skillInvocation = resolveSkillInvocation(inputText, structuredSkillInvocation);
      const idempotency = {
        key: idempotencyKey,
        requestHash: commandHash("run.create", {
          threadId: thread.entity.id,
          inputText,
          skillInvocation: skillInvocation ?? null,
        }),
      } as const;
      // 回放先于 createRun 的 active Thread 领域约束；归档不改变已经提交命令的 HTTP 结果。
      const replay = await capability.enqueueOutbox.replayQueuedRun({
        scope: auth.scope,
        thread: thread.entity,
        idempotency,
      });
      if (replay.outcome === "key_conflict") throw new ApiFailure("idempotency_conflict");
      if (replay.outcome === "legacy_drain_required") throw new ApiFailure("invalid_state");
      if (replay.outcome === "not_authorized") throw new ApiFailure("not_found");
      if (replay.outcome === "created" || replay.outcome === "replayed") {
        return toRunDto(replay.entity);
      }
      const run = createRun({
        id: this.dependencies.ids.run(),
        thread: thread.entity,
        now: this.dependencies.clock.now(),
      });
      const result = await capability.enqueueOutbox.createQueuedRun({
        scope: auth.scope,
        run,
        thread: thread.entity,
        ...(auth.apiKey === undefined ? {} : { origin: "api" as const }),
        inputText,
        ...(skillInvocation === undefined ? {} : { skillInvocation }),
        idempotency,
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("idempotency_conflict");
      if (result.outcome === "legacy_drain_required") throw new ApiFailure("invalid_state");
      if (result.outcome === "parent_inactive") throw new ApiFailure("invalid_state");
      if (result.outcome === "not_authorized") throw new ApiFailure("not_found");
      if (result.outcome === "skill_not_available") throw new ApiFailure("invalid_state");
      if (!("entity" in result)) throw new ApiFailure("internal");
      return toRunDto(result.entity);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async submitThreadInput(
    auth: AuthContext,
    rawThreadId: string,
    input: CreateThreadInputRequest,
    idempotencyKey: string,
  ): Promise<ThreadInputReceiptDto> {
    try {
      const routing = this.dependencies.createCapability?.threadInputs;
      if (routing === undefined) throw new ApiFailure("not_found");
      const attachmentReferences = [...(input.attachments ?? [])];
      const fileReferences: FileReference[] = [];
      for (const reference of input.fileReferences ?? []) {
        if (!validFileSelection(reference.selection) || reference.source.threadId !== rawThreadId)
          throw new ApiFailure("bad_request");
        await this.getRun(auth, rawThreadId, reference.source.runId);
        const found = await this.dependencies.experience?.getArtifact({
          scope: auth.scope,
          runId: runId(reference.source.runId),
          artifactId: reference.source.artifactId,
        });
        if (
          found?.outcome !== "found" ||
          found.artifact.resourceVersionId !== reference.source.versionId ||
          found.artifact.resourceId === undefined
        )
          throw new ApiFailure("not_found");
        if (
          reference.snapshot !== undefined &&
          !attachmentReferences.some(
            (item) =>
              item.resourceId === reference.snapshot?.resourceId &&
              item.versionId === reference.snapshot.versionId,
          )
        )
          throw new ApiFailure("bad_request");
        if (reference.selection.kind === "region" && reference.snapshot === undefined)
          throw new ApiFailure("bad_request");
        if (
          !attachmentReferences.some(
            (item) =>
              item.resourceId === found.artifact.resourceId &&
              item.versionId === found.artifact.resourceVersionId,
          )
        )
          attachmentReferences.push({
            resourceId: found.artifact.resourceId,
            versionId: found.artifact.resourceVersionId,
          });
        fileReferences.push({
          ...reference,
          source: {
            ...reference.source,
            name: found.artifact.name,
            ...(reference.source.mediaType === undefined
              ? {}
              : { mediaType: found.artifact.mediaType }),
          },
        });
      }
      if (input.input.trim().length === 0 && attachmentReferences.length === 0) {
        throw new ApiFailure("bad_request");
      }
      if (attachmentReferences.length > 0 && this.dependencies.resourceAttachments === undefined) {
        throw new ApiFailure("not_found");
      }
      const attachments =
        attachmentReferences.length === 0
          ? []
          : await this.dependencies.resourceAttachments?.resolve({
              context: auth.scope,
              attachments: attachmentReferences.map((attachment) => ({
                resourceId: resourceId(attachment.resourceId),
                versionId: resourceVersionId(attachment.versionId),
              })),
            });
      for (const reference of fileReferences) {
        if (reference.snapshot !== undefined) {
          const image = attachments?.find(
            (item) =>
              item.resourceId === reference.snapshot?.resourceId &&
              item.versionId === reference.snapshot.versionId,
          );
          if (image?.mediaType !== "image/png" || image.sizeBytes > 2 * 1024 * 1024)
            throw new ApiFailure("bad_request");
        }
      }
      const inputText = appendAttachmentsToLatestUserPrompt(
        appendFileReferences(input.input, fileReferences),
        attachments ?? [],
      );
      if (Buffer.byteLength(inputText, "utf8") > MAX_RUN_INPUT_UTF8_BYTES) {
        throw new ApiFailure("bad_request");
      }
      const thread = await this.dependencies.repositories.threads.get(
        auth.scope,
        threadId(rawThreadId),
      );
      if (thread === undefined) throw new ApiFailure("not_found");
      const skillInvocation = resolveSkillInvocation(input.input, input.skillInvocation);
      if (skillInvocation !== undefined && input.mode === "steer") {
        throw new ApiFailure("bad_request");
      }
      const fallbackRun = createRun({
        id: this.dependencies.ids.run(),
        thread: thread.entity,
        now: this.dependencies.clock.now(),
      });
      const result = await routing.submit({
        scope: auth.scope,
        thread: thread.entity,
        fallbackRun,
        inputText,
        attachments: (attachments ?? []).map((attachment) => ({
          resourceId: attachment.resourceId,
          versionId: attachment.versionId,
        })),
        mode: skillInvocation === undefined ? input.mode : "follow_up",
        ...(input.expectedRunId === undefined ? {} : { expectedRunId: input.expectedRunId }),
        ...(input.expectedTurnId === undefined ? {} : { expectedTurnId: input.expectedTurnId }),
        fallbackToFollowUp: input.fallbackToFollowUp ?? false,
        ...(skillInvocation === undefined ? {} : { skillInvocation }),
        idempotency: {
          key: idempotencyKey,
          requestHash: commandHash("thread.input", {
            threadId: thread.entity.id,
            input: input.input,
            attachments: attachmentReferences,
            ...(fileReferences.length === 0 ? {} : { fileReferences }),
            mode: input.mode,
            expectedRunId: input.expectedRunId ?? null,
            expectedTurnId: input.expectedTurnId ?? null,
            fallbackToFollowUp: input.fallbackToFollowUp ?? false,
            skillInvocation: skillInvocation ?? null,
          }),
        },
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("idempotency_conflict");
      if (result.outcome === "legacy_drain_required") throw new ApiFailure("invalid_state");
      if (result.outcome === "parent_inactive") throw new ApiFailure("invalid_state");
      if (result.outcome === "not_authorized") throw new ApiFailure("not_found");
      if (result.outcome === "skill_not_available") throw new ApiFailure("invalid_state");
      if (result.outcome !== "accepted" && result.outcome !== "replayed") {
        throw new ApiFailure("internal");
      }
      return {
        ...result.receipt,
        events: result.receipt.events.map((event) => ({ ...event })),
        ...(result.queuedRun === undefined ? {} : { queuedRun: toRunDto(result.queuedRun) }),
      };
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async getThreadInputReceipt(
    auth: AuthContext,
    rawThreadId: string,
    receiptId: string,
  ): Promise<ThreadInputReceiptDto> {
    const routing = this.dependencies.createCapability?.threadInputs;
    if (routing === undefined) throw new ApiFailure("not_found");
    const receipt = await routing.get({
      scope: auth.scope,
      threadId: threadId(rawThreadId),
      receiptId,
    });
    if (receipt === undefined) throw new ApiFailure("not_found");
    let queuedRun: RunDto | undefined;
    if (receipt.queuedRunId !== undefined) {
      const run = await this.dependencies.repositories.runs.get(
        auth.scope,
        runId(receipt.queuedRunId),
      );
      if (run === undefined || run.entity.threadId !== threadId(rawThreadId)) {
        throw new ApiFailure("not_found");
      }
      queuedRun = toRunDto(run.entity);
    }
    return {
      ...receipt,
      events: receipt.events.map((event) => ({ ...event })),
      ...(queuedRun === undefined ? {} : { queuedRun }),
    };
  }

  async getRun(auth: AuthContext, rawThreadId: string, rawRunId: string): Promise<RunDto> {
    const run = await this.dependencies.repositories.runs.get(auth.scope, runId(rawRunId));
    if (run === undefined || run.entity.threadId !== threadId(rawThreadId)) {
      throw new ApiFailure("not_found");
    }
    return toRunDto(run.entity, run.executionStatus);
  }

  /**
   * 最新窗口不是可续接的历史分页：先读取并授权 Thread，随后才投影该 Thread 的 Run。
   * 因而 Thread 不存在、跨租户和成员撤销在外部均保持同一个 404 失败关闭语义。
   */
  async listLatestRuns(
    auth: AuthContext,
    rawThreadId: string,
    input: { readonly limit?: number },
  ): Promise<{ readonly items: readonly RunDto[] }> {
    const parent = await this.dependencies.repositories.threads.get(
      auth.scope,
      threadId(rawThreadId),
    );
    if (parent === undefined) throw new ApiFailure("not_found");
    const items = await this.dependencies.repositories.runs.listByThread(
      auth.scope,
      parent.entity.id,
      { limit: input.limit ?? 20 },
    );
    return {
      items: items.map(({ entity, executionStatus }) => toRunDto(entity, executionStatus)),
    };
  }

  async cancelRun(auth: AuthContext, rawThreadId: string, rawRunId: string): Promise<RunDto> {
    const id = runId(rawRunId);
    const expectedThreadId = threadId(rawThreadId);
    try {
      const result = await cancelScopedRun(
        this.dependencies.repositories.runs,
        auth.scope,
        expectedThreadId,
        id,
        () => this.dependencies.clock.now(),
      );
      if (typeof result === "string") throw new ApiFailure(result);
      return toRunDto(result);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }
}

function resolveSkillInvocation(
  inputText: string,
  structured?: { readonly skill: string; readonly args?: string },
): ExplicitSkillInvocation | undefined {
  try {
    return resolveExplicitSkillInvocation({
      inputText,
      ...(structured === undefined ? {} : { structured }),
    });
  } catch (error) {
    if (error instanceof SkillRuntimeError) throw new ApiFailure("bad_request");
    throw error;
  }
}

export type { AuthContext };
