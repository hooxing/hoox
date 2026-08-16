import { createHash } from "node:crypto";
import {
  createRun,
  createThread,
  createWorkspace,
  DomainError,
  resourceId,
  resourceVersionId,
  runId,
  tenantId,
  threadId,
  transitionRun,
} from "@aisay/domain";
import type {
  CoreRepositories,
  TenantBundle,
  TenantScope,
  ThreadListCursor,
} from "@aisay/persistence";
import type {
  CreateThreadInputRequest,
  RunDto,
  ThreadDto,
  ThreadInputReceiptDto,
  ThreadPageDto,
} from "@aisay/protocol";
import { MAX_RUN_INPUT_UTF8_BYTES } from "@aisay/protocol";
import { toRunDto, toThreadDto } from "@aisay/protocol-mapper";
import {
  appendAttachmentsToLatestUserPrompt,
  type ResourceAttachmentResolverPort,
} from "@aisay/resource";
import {
  resolveExplicitSkillInvocation,
  SkillRuntimeError,
  type ExplicitSkillInvocation,
} from "@aisay/skill";
import type { ApiCreateCapability } from "./capabilities.js";
import { InvalidThreadCursorError } from "./cursor.js";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  AuthPrincipal,
  TenantSelector,
  ThreadCursorCodec,
} from "./ports.js";

export type ApiFailureKind =
  | "bad_request"
  | "unauthorized"
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
}

interface ServiceDependencies {
  readonly auth: AuthContextResolver;
  readonly repositories: CoreRepositories;
  readonly createCapability?: ApiCreateCapability;
  readonly archiveThread: ArchiveThreadCommandPort;
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
  ): Promise<AuthContext> {
    const principal = await this.dependencies.auth.resolve({ authorization, requestId });
    if (principal === undefined) throw new ApiFailure("unauthorized");
    if (tenantSelector.kind === "invalid") throw new ApiFailure("bad_request");
    let selectedTenantId = principal.tenantId;
    if (tenantSelector.kind === "selected") {
      try {
        selectedTenantId = tenantId(tenantSelector.value);
      } catch {
        throw new ApiFailure("bad_request");
      }
    } else if (selectedTenantId === undefined) {
      throw new ApiFailure("bad_request");
    }
    // JWT 只能证明 userId；X-Tenant-Id 只是候选 scope，Repository 会用 Membership 与 RLS 复核。
    const scope = { tenantId: selectedTenantId, userId: principal.userId } as const;
    const tenant = await this.dependencies.repositories.tenants.get(scope);
    // 凭据有效但成员关系无效时统一为不存在，不能成为租户成员枚举接口。
    if (tenant === undefined) throw new ApiFailure("not_found");
    return { principal, scope, tenant };
  }

  async createThread(auth: AuthContext, title: string, idempotencyKey: string): Promise<ThreadDto> {
    try {
      const capability = this.dependencies.createCapability;
      if (capability === undefined) throw new ApiFailure("not_found");
      const now = this.dependencies.clock.now();
      const thread = createThread({
        id: this.dependencies.ids.thread(),
        tenant: auth.tenant.tenant,
        user: auth.tenant.user,
        membership: auth.tenant.membership,
        title,
        now,
      });
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
          requestHash: commandHash("thread.create", { title: thread.title }),
        },
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("conflict");
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
      if (replay.outcome === "key_conflict") throw new ApiFailure("conflict");
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
        inputText,
        ...(skillInvocation === undefined ? {} : { skillInvocation }),
        idempotency,
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("conflict");
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
      const attachmentReferences = input.attachments ?? [];
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
      const inputText = appendAttachmentsToLatestUserPrompt(input.input, attachments ?? []);
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
            mode: input.mode,
            expectedRunId: input.expectedRunId ?? null,
            expectedTurnId: input.expectedTurnId ?? null,
            fallbackToFollowUp: input.fallbackToFollowUp ?? false,
            skillInvocation: skillInvocation ?? null,
          }),
        },
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("conflict");
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
    const current = await this.dependencies.repositories.runs.get(auth.scope, id);
    if (current === undefined || current.entity.threadId !== expectedThreadId) {
      throw new ApiFailure("not_found");
    }
    if (current.entity.status === "cancelled") return toRunDto(current.entity);
    try {
      const cancelled = transitionRun(current.entity, "cancelled", this.dependencies.clock.now());
      const result = await this.dependencies.repositories.runs.update(
        auth.scope,
        cancelled,
        current.version,
      );
      if (result.outcome === "not_found") throw new ApiFailure("not_found");
      if (result.outcome === "conflict") {
        const latest = await this.dependencies.repositories.runs.get(auth.scope, id);
        if (latest?.entity.status === "cancelled") return toRunDto(latest.entity);
        throw new ApiFailure("conflict");
      }
      return toRunDto(cancelled);
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
