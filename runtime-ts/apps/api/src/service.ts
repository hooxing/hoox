import { createHash } from "node:crypto";
import {
  createRun,
  createThread,
  createWorkspace,
  DomainError,
  runId,
  threadId,
  transitionRun,
} from "@cube-runtime/domain";
import type {
  CoreRepositories,
  TenantBundle,
  TenantScope,
  ThreadListCursor,
} from "@cube-runtime/persistence";
import { toRunDto, toThreadDto } from "@cube-runtime/protocol-mapper";
import type { RunDto, ThreadDto, ThreadPageDto } from "@cube-runtime/protocol";
import type {
  ApiClock,
  ApiIdGenerator,
  ArchiveThreadCommandPort,
  AuthContextResolver,
  AuthPrincipal,
  ThreadCursorCodec,
} from "./ports.js";
import type { ApiCreateCapability } from "./capabilities.js";
import { InvalidThreadCursorError } from "./cursor.js";

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

  async authenticate(authorization: string | undefined, requestId: string): Promise<AuthContext> {
    const principal = await this.dependencies.auth.resolve({ authorization, requestId });
    if (principal === undefined) throw new ApiFailure("unauthorized");
    const scope = { tenantId: principal.tenantId, userId: principal.userId } as const;
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

  async createRun(auth: AuthContext, rawThreadId: string, idempotencyKey: string): Promise<RunDto> {
    try {
      const capability = this.dependencies.createCapability;
      if (capability === undefined) throw new ApiFailure("not_found");
      const thread = await this.dependencies.repositories.threads.get(
        auth.scope,
        threadId(rawThreadId),
      );
      if (thread === undefined) throw new ApiFailure("not_found");
      const run = createRun({
        id: this.dependencies.ids.run(),
        thread: thread.entity,
        now: this.dependencies.clock.now(),
      });
      const result = await capability.enqueueOutbox.createQueuedRun({
        scope: auth.scope,
        run,
        idempotency: {
          key: idempotencyKey,
          requestHash: commandHash("run.create", { threadId: thread.entity.id }),
        },
      });
      if (result.outcome === "key_conflict") throw new ApiFailure("conflict");
      if (result.outcome === "parent_inactive") throw new ApiFailure("invalid_state");
      if (result.outcome === "not_authorized") throw new ApiFailure("not_found");
      return toRunDto(result.entity);
    } catch (error) {
      return mapDomainFailure(error);
    }
  }

  async getRun(auth: AuthContext, rawThreadId: string, rawRunId: string): Promise<RunDto> {
    const run = await this.dependencies.repositories.runs.get(auth.scope, runId(rawRunId));
    if (run === undefined || run.entity.threadId !== threadId(rawThreadId)) {
      throw new ApiFailure("not_found");
    }
    return toRunDto(run.entity);
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

export type { AuthContext };
