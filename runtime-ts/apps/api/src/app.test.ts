import {
  archiveThread,
  createMembership,
  createPersonalTenant,
  createUser,
  type IsoTimestamp,
  isoTimestamp,
  type MembershipRole,
  membershipId,
  type Run,
  rehydrateTenant,
  runId,
  type Tenant,
  type Thread,
  tenantId,
  threadId,
  type User,
  userId,
  type Workspace,
  workspaceId,
} from "@cube-runtime/domain";
import {
  type ArchiveThreadCommandPort,
  type BlobStore,
  BlobStoreError,
  type CoreRepositories,
  type RunExperienceReadPort,
  type TenantBundle,
  type TenantScope,
  type ThreadListPage,
  type Versioned,
} from "@cube-runtime/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { type ApiDependencies, createApiApp } from "./app.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec } from "./cursor.js";
import type {
  AuthPrincipal,
  EnqueueOutboxPort,
  IdempotentCommand,
  IdempotentCreateResult,
  ThreadCreationPort,
} from "./ports.js";

class AsyncBarrier {
  private arrived = 0;
  private release!: () => void;
  private readonly promise = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  constructor(private readonly parties: number) {}

  async wait(): Promise<void> {
    this.arrived += 1;
    if (this.arrived === this.parties) this.release();
    await this.promise;
  }
}

class AsyncMutex {
  private tail = Promise.resolve();

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

const baseTime = isoTimestamp("2099-07-26T08:00:00.000Z");
const alternateExperienceRunId = runId("run_2");
const experienceArtifact = {
  id: "artifact_1",
  tenantId: tenantId("tenant_owner_a"),
  runId: runId("run_1"),
  threadId: threadId("thread_1"),
  resourceVersionId: "resource_version_1",
  name: "交付说明.txt",
  mediaType: "text/plain",
  sizeBytes: 42,
  createdAt: baseTime,
  updatedAt: baseTime,
  authorizationRevision: "false:2099-07-26T08:00:00.000Z:2099-07-26T08:00:00.000Z",
  blob: {
    kind: "stable" as const,
    tenantId: tenantId("tenant_owner_a"),
    purpose: "resource" as const,
    sha256: "a".repeat(64),
    size: 42,
    mediaType: "text/plain",
    incarnationId: "00000000-0000-4000-8000-000000000001",
    physicalObjectKey:
      "agent-runtime/stable/tenant_owner_a/resource/sha256/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/incarnations/00000000-0000-4000-8000-000000000001",
  },
};

const artifactConfirmationDrifts = [
  "authorizationRevision",
  "tenantId",
  "threadId",
  "runId",
  "artifactId",
  "resourceVersionId",
  "mediaType",
  "sizeBytes",
  "blobTenantId",
  "blobPurpose",
  "blobSha256",
  "blobSize",
  "blobMediaType",
  "blobIncarnationId",
  "physicalObjectKey",
] as const;
type ArtifactConfirmationDrift = (typeof artifactConfirmationDrifts)[number];

function key(scope: TenantScope, id: string): string {
  return `${scope.tenantId}:${id}`;
}

class FakeApiState implements ThreadCreationPort, EnqueueOutboxPort, ArchiveThreadCommandPort {
  readonly tenants = new Map<string, TenantBundle>();
  readonly principals = new Map<string, AuthPrincipal>();
  readonly threads = new Map<string, Versioned<Thread>>();
  readonly runs = new Map<string, Versioned<Run>>();
  readonly workspaces = new Map<string, Workspace>();
  readonly idempotency = new Map<
    string,
    { readonly hash: string; readonly entity: Thread | Run }
  >();
  enqueueParentInactive = false;
  readonly revokedScopes = new Set<string>();
  readonly roleOverrides = new Map<string, MembershipRole>();
  readonly idempotencyFirstObservations: boolean[] = [];
  readonly idempotencyOutcomes: ("created" | "replayed")[] = [];
  idempotencyBarrier: AsyncBarrier | undefined;
  beforeThreadCreate: (() => Promise<void> | void) | undefined;
  beforeRunCreate: (() => Promise<void> | void) | undefined;
  beforeArchive: (() => Promise<void> | void) | undefined;
  private readonly mutex = new AsyncMutex();

  readonly repositories: CoreRepositories = {
    tenants: {
      createPersonal: async () => ({ outcome: "conflict" }),
      get: async (scope) => this.tenants.get(key(scope, scope.userId)),
    },
    threads: {
      create: async () => ({ outcome: "conflict" }),
      get: async (scope, id) => this.threads.get(key(scope, id)),
      list: async (scope, input): Promise<ThreadListPage> => {
        const ordered = [...this.threads.entries()]
          .filter(([storedKey]) => storedKey.startsWith(`${scope.tenantId}:`))
          .map(([, value]) => value)
          .sort((left, right) => {
            const byTime = right.entity.updatedAt.localeCompare(left.entity.updatedAt);
            return byTime === 0 ? right.entity.id.localeCompare(left.entity.id) : byTime;
          });
        const start =
          input.cursor === undefined
            ? 0
            : (() => {
                const cursor = input.cursor;
                return ordered.findIndex(
                  ({ entity }) =>
                    entity.updatedAt < cursor.updatedAt ||
                    (entity.updatedAt === cursor.updatedAt && entity.id < cursor.id),
                );
              })();
        const actualStart = start < 0 ? ordered.length : start;
        const items = ordered.slice(actualStart, actualStart + input.limit);
        const last = items.at(-1)?.entity;
        return {
          items,
          ...(last === undefined || actualStart + input.limit >= ordered.length
            ? {}
            : { nextCursor: { updatedAt: last.updatedAt, id: last.id } }),
        };
      },
      update: async (scope, entity, expectedVersion) => {
        const storedKey = key(scope, entity.id);
        const current = this.threads.get(storedKey);
        if (current === undefined) return { outcome: "not_found" };
        if (current.version !== expectedVersion) return { outcome: "conflict" };
        const version = current.version + 1n;
        this.threads.set(storedKey, { entity, version });
        return { outcome: "updated", version };
      },
    },
    runs: {
      create: async () => ({ outcome: "conflict" }),
      get: async (scope, id) => this.runs.get(key(scope, id)),
      listByThread: async (scope, threadId, input) =>
        [...this.runs.entries()]
          .filter(
            ([storedKey, value]) =>
              storedKey.startsWith(`${scope.tenantId}:`) && value.entity.threadId === threadId,
          )
          .map(([, value]) => value)
          .sort((left, right) => {
            const byUpdated = right.entity.updatedAt.localeCompare(left.entity.updatedAt);
            if (byUpdated !== 0) return byUpdated;
            const byCreated = right.entity.createdAt.localeCompare(left.entity.createdAt);
            return byCreated === 0 ? right.entity.id.localeCompare(left.entity.id) : byCreated;
          })
          .slice(0, input.limit),
      update: async (scope, entity, expectedVersion) => {
        const storedKey = key(scope, entity.id);
        const current = this.runs.get(storedKey);
        if (current === undefined) return { outcome: "not_found" };
        if (current.version !== expectedVersion) return { outcome: "conflict" };
        const version = current.version + 1n;
        this.runs.set(storedKey, { entity, version });
        return { outcome: "updated", version };
      },
    },
    workspaces: {
      create: async () => ({ outcome: "conflict" }),
      getById: async (scope, id) => this.workspaces.get(key(scope, id)),
      getByThread: async (scope, id) =>
        [...this.workspaces.entries()].find(
          ([storedKey, workspace]) =>
            storedKey.startsWith(`${scope.tenantId}:`) && workspace.threadId === id,
        )?.[1],
      compareAndSetLease: async () => ({ outcome: "lease_lost" }),
      commitRevision: async () => ({ outcome: "lease_lost" }),
    },
  };

  register(token: string, bundle: TenantBundle): void {
    const scope = { tenantId: bundle.tenant.id, userId: bundle.user.id };
    this.principals.set(token, scope);
    this.tenants.set(key(scope, scope.userId), bundle);
  }

  revokeCommands(scope: TenantScope): void {
    this.revokedScopes.add(key(scope, scope.userId));
  }

  revokeMembership(scope: TenantScope): void {
    // 模拟 PG Membership/RLS 在认证后再次读取时发现 inactive/revoked 的结果。
    this.tenants.delete(key(scope, scope.userId));
  }

  overrideRole(scope: TenantScope, role: MembershipRole): void {
    this.roleOverrides.set(key(scope, scope.userId), role);
  }

  private activeRole(scope: TenantScope): MembershipRole | undefined {
    const scopeKey = key(scope, scope.userId);
    if (this.revokedScopes.has(scopeKey)) return undefined;
    const membership = this.tenants.get(scopeKey)?.membership;
    if (membership?.status !== "active") return undefined;
    return this.roleOverrides.get(scopeKey) ?? membership.role;
  }

  async createThread(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly workspace: Workspace;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Thread>> {
    await this.beforeThreadCreate?.();
    return this.idempotent(input.scope, "thread", input.idempotency, input.thread, () => {
      this.threads.set(key(input.scope, input.thread.id), { entity: input.thread, version: 0n });
      this.workspaces.set(key(input.scope, input.workspace.id), input.workspace);
    });
  }

  async createQueuedRun(input: {
    readonly scope: TenantScope;
    readonly run: Run;
    readonly thread: Thread;
    readonly inputText: string;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run>> {
    await this.beforeRunCreate?.();
    return this.idempotent(input.scope, "run", input.idempotency, input.run, () => {
      this.runs.set(key(input.scope, input.run.id), { entity: input.run, version: 0n });
    });
  }

  async replayQueuedRun(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run> | { readonly outcome: "not_found" }> {
    const commandKey = `${input.scope.tenantId}:${input.scope.userId}:run:${input.idempotency.key}`;
    const existing = this.idempotency.get(commandKey);
    if (existing === undefined) return { outcome: "not_found" };
    if (existing.hash !== input.idempotency.requestHash) return { outcome: "key_conflict" };
    return { outcome: "replayed", entity: existing.entity as Run };
  }

  async archiveThread(
    input: Parameters<ArchiveThreadCommandPort["archiveThread"]>[0],
  ): ReturnType<ArchiveThreadCommandPort["archiveThread"]> {
    await this.beforeArchive?.();
    return this.mutex.run(() => {
      const role = this.activeRole(input.scope);
      if (role !== "owner" && role !== "admin") return { outcome: "not_authorized" };
      const storedKey = key(input.scope, input.threadId);
      const current = this.threads.get(storedKey);
      if (current === undefined) return { outcome: "not_found" };
      if (current.entity.status === "archived") {
        return { outcome: "already_archived", entity: current.entity };
      }
      const entity = archiveThread(
        current.entity,
        isoTimestamp(new Date(Date.parse(current.entity.updatedAt) + 1_000).toISOString()),
      );
      this.threads.set(storedKey, { entity, version: current.version + 1n });
      return { outcome: "archived", entity };
    });
  }

  private async idempotent<T extends Thread | Run>(
    scope: TenantScope,
    operation: string,
    command: IdempotentCommand,
    entity: T,
    commit: () => void,
  ): Promise<IdempotentCreateResult<T>> {
    const commandKey = `${scope.tenantId}:${scope.userId}:${operation}:${command.key}`;
    this.idempotencyFirstObservations.push(this.idempotency.has(commandKey));
    await this.idempotencyBarrier?.wait();
    return this.mutex.run(() => {
      if (this.activeRole(scope) === undefined) return { outcome: "not_authorized" };
      if (operation === "run") {
        if (this.enqueueParentInactive) return { outcome: "parent_inactive" };
        const run = entity as Run;
        const parent = this.threads.get(key(scope, run.threadId));
        if (parent?.entity.status !== "active") return { outcome: "parent_inactive" };
      }
      const existing = this.idempotency.get(commandKey);
      if (existing !== undefined) {
        if (existing.hash !== command.requestHash) return { outcome: "key_conflict" };
        this.idempotencyOutcomes.push("replayed");
        return { outcome: "replayed", entity: existing.entity as T };
      }
      commit();
      this.idempotency.set(commandKey, { hash: command.requestHash, entity });
      this.idempotencyOutcomes.push("created");
      return { outcome: "created", entity };
    });
  }
}

class FakeClock {
  private second = 0;

  now(): IsoTimestamp {
    const value = `2099-07-26T08:00:${this.second.toString().padStart(2, "0")}.000Z`;
    this.second += 1;
    return isoTimestamp(value);
  }
}

function personalBundle(suffix: string): TenantBundle {
  const user = createUser(userId(`user_${suffix}`), baseTime);
  const personal = createPersonalTenant({
    id: tenantId(`tenant_${suffix}`),
    ownerMembershipId: membershipId(`membership_${suffix}`),
    owner: user,
    createdAt: baseTime,
  });
  return { user, tenant: personal.tenant, membership: personal.ownerMembership };
}

function teamBundle(input: {
  readonly suffix: string;
  readonly tenant: Tenant;
  readonly user: User;
  readonly role: MembershipRole;
}): TenantBundle {
  return {
    user: input.user,
    tenant: input.tenant,
    membership: createMembership({
      id: membershipId(`membership_${input.suffix}`),
      tenant: input.tenant,
      user: input.user,
      role: input.role,
      createdAt: baseTime,
    }),
  };
}

function fixture(
  options: {
    readonly enableCreate?: boolean;
    readonly enableExperience?: boolean;
    readonly includeArtifact?: boolean;
    readonly confirmationDrift?: ArtifactConfirmationDrift;
    readonly artifactMediaType?: string;
    readonly artifactSizeBytes?: number;
    readonly blobBytes?: Uint8Array;
    readonly blobFailure?: BlobStoreError;
    readonly productionPrincipalOnly?: boolean;
  } = {},
) {
  const state = new FakeApiState();
  const ownerA = personalBundle("owner_a");
  const ownerB = personalBundle("owner_b");
  state.register("Bearer token-a", ownerA);
  state.register("Bearer token-b", ownerB);
  let threadSequence = 0;
  let runSequence = 0;
  let workspaceSequence = 0;
  let artifactReadCount = 0;
  const artifactSizeBytes = options.artifactSizeBytes ?? experienceArtifact.sizeBytes;
  const blobBytes = options.blobBytes ?? new Uint8Array(artifactSizeBytes);
  const presignInputs: unknown[] = [];
  const configuredArtifact = {
    ...experienceArtifact,
    sizeBytes: artifactSizeBytes,
    mediaType: options.artifactMediaType ?? experienceArtifact.mediaType,
    blob: {
      ...experienceArtifact.blob,
      size: artifactSizeBytes,
      mediaType: options.artifactMediaType ?? experienceArtifact.blob.mediaType,
    },
  };
  const clock = new FakeClock();
  const dependencies: ApiDependencies = {
    auth: {
      resolve: async ({ authorization }) => {
        const principal =
          authorization === undefined ? undefined : state.principals.get(authorization);
        return principal === undefined || options.productionPrincipalOnly !== true
          ? principal
          : Object.freeze({ userId: principal.userId });
      },
    },
    repositories: state.repositories,
    ...(options.enableCreate === false
      ? {}
      : {
          createCapability: createApiCreateCapability({
            threadCreation: state,
            enqueueOutbox: state,
          }),
        }),
    archiveThread: state,
    cursorCodec: createThreadCursorCodec({
      activeKid: "test-key",
      keys: [{ kid: "test-key", secret: Buffer.alloc(32, 7).toString("base64url") }],
      clock,
      ttlMilliseconds: 60_000,
      maximumTtlMilliseconds: 60_000,
    }),
    readiness: { probe: async () => undefined },
    clock,
    ids: {
      thread: () => threadId(`thread_${++threadSequence}`),
      run: () => runId(`run_${++runSequence}`),
      workspace: () => workspaceId(`workspace_${++workspaceSequence}`),
    },
    ...(options.enableExperience === true
      ? {
          experience: {
            listEvents: async ({ runId, after, limit }) => {
              if (runId !== "run_1") return { outcome: "not_found" } as const;
              return {
                outcome: "found" as const,
                attemptId: "attempt_1",
                events: [
                  {
                    sequence: 1,
                    kind: "attempt_state_changed",
                    payload: { status: "running", stage: "model_execution_started" },
                    occurredAt: baseTime,
                  },
                  {
                    sequence: 2,
                    kind: "agent_event",
                    payload: { type: "message.delta", delta: "正在处理" },
                    occurredAt: baseTime,
                  },
                ]
                  .filter((event) => event.sequence > after)
                  .slice(0, limit),
                hasMore: false,
              };
            },
            listArtifacts: async ({ runId }) =>
              runId === "run_1"
                ? {
                    outcome: "found" as const,
                    artifacts: options.includeArtifact ? [configuredArtifact] : [],
                  }
                : { outcome: "not_found" as const },
            getArtifact: async ({ runId, artifactId }) => {
              if (
                runId !== "run_1" ||
                !options.includeArtifact ||
                artifactId !== configuredArtifact.id
              ) {
                return { outcome: "not_found" as const };
              }
              artifactReadCount += 1;
              const confirmationDrift = options.confirmationDrift;
              return {
                outcome: "found" as const,
                artifact:
                  confirmationDrift !== undefined && artifactReadCount >= 2
                    ? {
                        ...configuredArtifact,
                        ...(confirmationDrift === "authorizationRevision"
                          ? {
                              authorizationRevision: `${configuredArtifact.authorizationRevision}:changed`,
                            }
                          : {}),
                        ...(confirmationDrift === "tenantId"
                          ? { tenantId: tenantId("tenant_owner_b") }
                          : {}),
                        ...(confirmationDrift === "threadId"
                          ? { threadId: threadId("thread_2") }
                          : {}),
                        ...(confirmationDrift === "runId"
                          ? { runId: alternateExperienceRunId }
                          : {}),
                        ...(confirmationDrift === "artifactId" ? { id: "artifact_2" } : {}),
                        ...(confirmationDrift === "resourceVersionId"
                          ? { resourceVersionId: "resource_version_2" }
                          : {}),
                        ...(confirmationDrift === "mediaType"
                          ? { mediaType: "application/pdf" }
                          : {}),
                        ...(confirmationDrift === "sizeBytes" ? { sizeBytes: 43 } : {}),
                        blob: {
                          ...configuredArtifact.blob,
                          ...(confirmationDrift === "blobTenantId"
                            ? { tenantId: tenantId("tenant_owner_b") }
                            : {}),
                          ...(confirmationDrift === "blobPurpose"
                            ? { purpose: "preview" as const }
                            : {}),
                          ...(confirmationDrift === "blobSha256" ? { sha256: "b".repeat(64) } : {}),
                          ...(confirmationDrift === "blobSize" ? { size: 43 } : {}),
                          ...(confirmationDrift === "blobMediaType"
                            ? { mediaType: "application/pdf" }
                            : {}),
                          ...(confirmationDrift === "blobIncarnationId"
                            ? { incarnationId: "00000000-0000-4000-8000-000000000002" }
                            : {}),
                          ...(confirmationDrift === "physicalObjectKey"
                            ? {
                                physicalObjectKey: `${configuredArtifact.blob.physicalObjectKey}-changed`,
                              }
                            : {}),
                        },
                      }
                    : configuredArtifact,
              };
            },
          } satisfies RunExperienceReadPort,
          ...(options.includeArtifact
            ? {
                blobs: {
                  getBytes: async () => {
                    if (options.blobFailure !== undefined) throw options.blobFailure;
                    return blobBytes;
                  },
                  presignDownload: async (input: Parameters<BlobStore["presignDownload"]>[0]) => {
                    if (options.blobFailure !== undefined) throw options.blobFailure;
                    presignInputs.push(input);
                    return "http://127.0.0.1:19000/short-lived-download";
                  },
                } as unknown as BlobStore,
              }
            : {}),
        }
      : {}),
  };
  const app = createApiApp(dependencies, { logger: false });
  return { app, state, dependencies, ownerA, ownerB, presignInputs };
}

const openApps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Fastify API 契约", () => {
  it("按稳定最新快照顺序读取 Thread 的 Run，并对无权 Thread 失败关闭", async () => {
    const { app } = fixture();
    openApps.push(app);
    for (const suffix of ["one", "two", "three"] as const) {
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `thread-latest-${suffix}-0001`,
        },
        payload: { title: "最新 Run" },
      });
      await app.inject({
        method: "POST",
        url: `/v1/threads/thread_${suffix === "one" ? 1 : suffix === "two" ? 2 : 3}/runs`,
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `run-latest-${suffix}-0001`,
        },
        payload: { input: "恢复运行" },
      });
    }
    // 再在同一 Thread 创建一条 Run，较新的 updatedAt 应优先；limit 仅截取同一快照的最近窗口。
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-latest-four-0001" },
      payload: { input: "同线程新运行" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs?limit=1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items.map((run: { id: string }) => run.id)).toEqual(["run_4"]);
    const forbidden = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs?limit=1",
      headers: { authorization: "Bearer token-b" },
    });
    expect(forbidden.statusCode).toBe(404);
  });

  it("Run 事件按 sequence 增量读取，并维持 Thread/租户边界", async () => {
    const { app, state } = fixture({ enableExperience: true });
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-events-0001" },
      payload: { title: "事件任务" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-events-0001" },
      payload: { input: "生成事件" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/events?after=1&limit=10",
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      attemptId: "attempt_1",
      items: [
        {
          eventId: "attempt_1-2",
          sequence: 2,
          kind: "agent_event",
          type: "message.delta",
        },
      ],
    });
    const initial = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/events?after=-1&limit=10",
      headers: { authorization: "Bearer token-a" },
    });
    expect(initial.json().data.items[0]).toMatchObject({
      kind: "attempt_state_changed",
      type: "attempt_state_changed",
    });
    const otherTenant = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/events",
      headers: { authorization: "Bearer token-b" },
    });
    expect(otherTenant.statusCode).toBe(404);
    expect(state.runs).toHaveLength(1);
  });

  it("UTF-8 纯文本预览经 API 返回安全文本而不暴露 S3 URL", async () => {
    const payload = "<script>window.pwned=true</script>";
    const { app, presignInputs } = fixture({
      enableExperience: true,
      includeArtifact: true,
      artifactMediaType: "text/plain; charset=utf-8",
      artifactSizeBytes: new TextEncoder().encode(payload).byteLength,
      blobBytes: new TextEncoder().encode(payload),
    });
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-artifacts-0001" },
      payload: { title: "交付物任务" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-artifacts-0001" },
      payload: { input: "生成交付物" },
    });
    const list = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts",
      headers: { authorization: "Bearer token-a" },
    });
    expect(list.json().data.items).toHaveLength(1);
    const preview = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/preview",
      headers: { authorization: "Bearer token-a" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers["content-type"]).toContain("application/json");
    expect(preview.headers["cache-control"]).toBe("no-store");
    expect(preview.headers.pragma).toBe("no-cache");
    expect(preview.headers["x-content-type-options"]).toBe("nosniff");
    expect(preview.json().data).toEqual(
      expect.objectContaining({ disposition: "preview", text: payload }),
    );
    expect(preview.json().data.url).toBeUndefined();
    expect(presignInputs).toHaveLength(0);
    const download = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/download",
      headers: { authorization: "Bearer token-a" },
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["cache-control"]).toBe("no-store");
    expect(download.headers.pragma).toBe("no-cache");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(presignInputs).toContainEqual(
      expect.objectContaining({ delivery: "artifact-download", downloadName: "交付说明.txt" }),
    );
    const wrongRun = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_2/artifacts/artifact_1/download",
      headers: { authorization: "Bearer token-a" },
    });
    expect(wrongRun.statusCode).toBe(404);
  });

  it("PNG 预览仍签发 inline URL", async () => {
    const { app, presignInputs } = fixture({
      enableExperience: true,
      includeArtifact: true,
      artifactMediaType: "image/png",
    });
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "image-preview-thread" },
      payload: { title: "二进制预览" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "image-preview-run" },
      payload: { input: "预览图片" },
    });
    const preview = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/preview",
      headers: { authorization: "Bearer token-a" },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data).toMatchObject({
      disposition: "preview",
      url: "http://127.0.0.1:19000/short-lived-download",
    });
    expect(presignInputs).toContainEqual(expect.objectContaining({ delivery: "inline-preview" }));
  });

  it.each(artifactConfirmationDrifts)(
    "Artifact 签名后 %s 字段漂移时不返回 URL",
    async (confirmationDrift) => {
      const { app } = fixture({
        enableExperience: true,
        includeArtifact: true,
        confirmationDrift,
      });
      openApps.push(app);
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `artifact-${confirmationDrift}-thread`,
        },
        payload: { title: "交付物竞态" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/threads/thread_1/runs",
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `artifact-${confirmationDrift}-run`,
        },
        payload: { input: "生成交付物" },
      });
      const response = await app.inject({
        method: "GET",
        url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/download",
        headers: { authorization: "Bearer token-a" },
      });
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("short-lived-download");
    },
  );

  it("BlobStore 失败映射为稳定 503 且不泄漏内部消息", async () => {
    const { app } = fixture({
      enableExperience: true,
      includeArtifact: true,
      blobFailure: new BlobStoreError("BLOB_PROVIDER_ERROR", "credential-canary"),
    });
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "blob-error-thread" },
      payload: { title: "对象存储失败" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "blob-error-run" },
      payload: { input: "生成交付物" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/download",
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(response.body).not.toContain("credential-canary");
  });

  it.each(["text/html", "image/svg+xml", "application/xml"])(
    "主动内容 %s 不能 inline 预览，但仍可 attachment 下载",
    async (artifactMediaType) => {
      const { app } = fixture({ enableExperience: true, includeArtifact: true, artifactMediaType });
      openApps.push(app);
      const mediaKey = artifactMediaType.replace(/[^A-Za-z0-9]/gu, "-");
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `media-thread-${mediaKey}`,
        },
        payload: { title: "媒体类型边界" },
      });
      await app.inject({
        method: "POST",
        url: "/v1/threads/thread_1/runs",
        headers: {
          authorization: "Bearer token-a",
          "idempotency-key": `media-run-${mediaKey}`,
        },
        payload: { input: "生成交付物" },
      });
      const preview = await app.inject({
        method: "GET",
        url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/preview",
        headers: { authorization: "Bearer token-a" },
      });
      expect(preview.statusCode).toBe(422);
      expect(preview.json().error.code).toBe("INVALID_STATE");
      const download = await app.inject({
        method: "GET",
        url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/download",
        headers: { authorization: "Bearer token-a" },
      });
      expect(download.statusCode).toBe(200);
      expect(download.json().data.disposition).toBe("download");
    },
  );

  it.each([
    ["text/plain; charset=utf-8", 200],
    ["text/plain", 422],
    ['text/plain; charset="us-ascii"', 422],
    ["text/plain; charset=iso-8859-1", 422],
    ["text/plain; charset=windows-1252", 422],
    ["text/plain; charset=utf-7", 422],
  ] as const)("纯文本预览只接受规范 UTF-8：%s", async (artifactMediaType, statusCode) => {
    const { app } = fixture({ enableExperience: true, includeArtifact: true, artifactMediaType });
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "text-media-thread" },
      payload: { title: "纯文本媒体类型" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "text-media-run" },
      payload: { input: "生成交付物" },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/preview",
      headers: { authorization: "Bearer token-a" },
    });
    expect(response.statusCode).toBe(statusCode);
  });

  it("过大或非 UTF-8 的纯文本预览失败关闭", async () => {
    const tooLarge = fixture({
      enableExperience: true,
      includeArtifact: true,
      artifactSizeBytes: 1_024 * 1_024 + 1,
    });
    openApps.push(tooLarge.app);
    const invalidUtf8 = fixture({
      enableExperience: true,
      includeArtifact: true,
      artifactSizeBytes: 1,
      blobBytes: new Uint8Array([0xff]),
    });
    openApps.push(invalidUtf8.app);
    for (const [suffix, target] of [
      ["oversize", tooLarge.app],
      ["utf8", invalidUtf8.app],
    ] as const) {
      await target.inject({
        method: "POST",
        url: "/v1/threads",
        headers: { authorization: "Bearer token-a", "idempotency-key": `text-fail-${suffix}` },
        payload: { title: "文本失败关闭" },
      });
      await target.inject({
        method: "POST",
        url: "/v1/threads/thread_1/runs",
        headers: { authorization: "Bearer token-a", "idempotency-key": `text-fail-run-${suffix}` },
        payload: { input: "预览文本" },
      });
      const response = await target.inject({
        method: "GET",
        url: "/v1/threads/thread_1/runs/run_1/artifacts/artifact_1/preview",
        headers: { authorization: "Bearer token-a" },
      });
      expect(response.statusCode).toBe(422);
    }
  });
  it("live/ready 返回服务端 requestId，依赖失败不泄漏原始错误", async () => {
    const { app, dependencies } = fixture();
    openApps.push(app);
    const live = await app.inject({ method: "GET", url: "/live" });
    expect(live.statusCode).toBe(200);
    expect(live.headers["x-request-id"]).toBe(live.json().requestId);
    expect((app.initialConfig as { readonly requestTimeout?: number }).requestTimeout).toBe(15_000);
    dependencies.readiness.probe = async () => {
      throw new Error("postgres://credential-canary@internal");
    };
    const ready = await app.inject({ method: "GET", url: "/ready" });
    expect(ready.statusCode).toBe(503);
    expect(ready.body).not.toContain("credential-canary");
    expect(ready.json().error).toEqual({
      code: "DEPENDENCY_UNAVAILABLE",
      message: "依赖服务暂时不可用",
      retryable: true,
    });

    const timeoutApp = createApiApp(
      {
        ...dependencies,
        readiness: { probe: () => new Promise(() => undefined) },
      },
      { logger: false, requestTimeoutMs: 20 },
    );
    openApps.push(timeoutApp);
    const timedOut = await timeoutApp.inject({ method: "GET", url: "/ready" });
    expect(timedOut.statusCode).toBe(503);
    expect(timedOut.json().error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("Thread create/get/list/archive 使用严格 JSON、幂等和游标分页", async () => {
    const { app } = fixture();
    openApps.push(app);
    const headers = { authorization: "Bearer token-a", "idempotency-key": "thread-key-0001" };
    const created = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers,
      payload: { title: "  第一个任务  " },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json().data).toMatchObject({ id: "thread_1", title: "第一个任务" });
    const replayed = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers,
      payload: { title: "第一个任务" },
    });
    expect(replayed.json().data.id).toBe("thread_1");
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers,
      payload: { title: "其他任务" },
    });
    expect(conflict.statusCode).toBe(409);
    const extra = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { ...headers, "idempotency-key": "thread-key-0002" },
      payload: { title: "拒绝", tenantId: "tenant_owner_b" },
    });
    expect(extra.statusCode).toBe(400);

    for (const [idempotency, title] of [
      ["thread-key-0003", "第二个任务"],
      ["thread-key-0004", "第三个任务"],
    ] as const) {
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: { authorization: "Bearer token-a", "idempotency-key": idempotency },
        payload: { title },
      });
    }
    const firstPage = await app.inject({
      method: "GET",
      url: "/v1/threads?limit=2",
      headers: { authorization: "Bearer token-a" },
    });
    expect(firstPage.json().data.items).toHaveLength(2);
    const secondPage = await app.inject({
      method: "GET",
      url: `/v1/threads?limit=2&cursor=${encodeURIComponent(firstPage.json().data.nextCursor)}`,
      headers: { authorization: "Bearer token-a" },
    });
    expect(secondPage.json().data.items).toHaveLength(1);

    const archived = await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(archived.json().data.status).toBe("archived");
    const repeatedArchive = await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(repeatedArchive.statusCode).toBe(200);
  });

  it("principal 与 Membership 决定 TenantScope，裸 tenant Header 不能越权", async () => {
    const { app } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-key-tenant" },
      payload: { title: "A 租户任务" },
    });
    const crossTenant = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer token-b", "x-tenant-id": "tenant_owner_a" },
    });
    expect(crossTenant.statusCode).toBe(404);
    expect(crossTenant.json().error.code).toBe("NOT_FOUND");
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/threads/thread_1" });
    expect(unauthenticated.statusCode).toBe(401);
  });

  it("生产 JWT user principal 只能把 X-Tenant-Id 当作经 Membership/RLS 二次验证的选择器", async () => {
    const { app, ownerA, ownerB, state } = fixture({ productionPrincipalOnly: true });
    openApps.push(app);
    const missingSelector = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a" },
    });
    expect(missingSelector.statusCode).toBe(400);
    const malformedSelector = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "x-tenant-id": "tenant with spaces" },
    });
    expect(malformedSelector.statusCode).toBe(400);
    const duplicateSelector = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: {
        authorization: "Bearer token-a",
        "x-tenant-id": [ownerA.tenant.id, ownerA.tenant.id],
      },
    });
    expect(duplicateSelector.statusCode).toBe(400);
    const forgedTenant = await app.inject({
      method: "GET",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "x-tenant-id": ownerB.tenant.id },
    });
    expect(forgedTenant.statusCode).toBe(404);

    const created = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: {
        authorization: "Bearer token-a",
        "x-tenant-id": ownerA.tenant.id,
        "idempotency-key": "production-selector-thread-key",
      },
      payload: { title: "生产租户选择器" },
    });
    expect(created.statusCode).toBe(200);
    state.revokeMembership({ tenantId: ownerA.tenant.id, userId: ownerA.user.id });
    const inactiveMembership = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer token-a", "x-tenant-id": ownerA.tenant.id },
    });
    // 有效 JWT 也不能绕过当前 Membership/RLS；外部保持 not_found，不能枚举租户成员关系。
    expect(inactiveMembership.statusCode).toBe(404);
  });

  it("member 可读取但不可归档，权限失败不泄漏 Thread 存在性", async () => {
    const { app, state } = fixture();
    openApps.push(app);
    const creator = createUser(userId("user_team_creator"), baseTime);
    const tenant = rehydrateTenant(
      {
        id: "tenant_team",
        kind: "team",
        displayName: "测试团队",
        createdByUserId: creator.id,
        createdAt: baseTime,
      },
      creator,
    );
    const owner = teamBundle({ suffix: "team_owner", tenant, user: creator, role: "owner" });
    const memberUser = createUser(userId("user_team_member"), baseTime);
    const member = teamBundle({ suffix: "team_member", tenant, user: memberUser, role: "member" });
    state.register("Bearer team-owner", owner);
    state.register("Bearer team-member", member);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer team-owner", "idempotency-key": "team-thread-key" },
      payload: { title: "团队任务" },
    });
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/threads/thread_1",
          headers: { authorization: "Bearer team-member" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/v1/threads/thread_1",
          headers: { authorization: "Bearer team-member" },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("Run 只以 queued 原子入队，幂等重放不产生第二个 Run", async () => {
    const { app, state } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-for-run" },
      payload: { title: "Run 任务" },
    });
    const request = {
      method: "POST" as const,
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-key-0001" },
      payload: { input: "请生成执行结果" },
    };
    state.idempotencyFirstObservations.length = 0;
    state.idempotencyOutcomes.length = 0;
    state.idempotencyBarrier = new AsyncBarrier(2);
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(first.json().data).toMatchObject({ id: "run_1", status: "queued" });
    expect(second.json().data.id).toBe("run_1");
    expect(state.runs).toHaveLength(1);
    expect(state.idempotencyFirstObservations).toEqual([false, false]);
    expect([...state.idempotencyOutcomes].sort()).toEqual(["created", "replayed"]);

    const conflict = await app.inject({
      ...request,
      payload: { input: "相同幂等键但不同输入" },
    });
    expect(conflict.statusCode).toBe(409);

    const loaded = await app.inject({
      method: "GET",
      url: "/v1/threads/thread_1/runs/run_1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().data.status).toBe("queued");

    const cancelled = await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1/runs/run_1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(cancelled.json().data.status).toBe("cancelled");
    const repeated = await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1/runs/run_1",
      headers: { authorization: "Bearer token-a" },
    });
    expect(repeated.statusCode).toBe(200);
  });

  it("Thread 归档竞态由 EnqueueOutboxPort 在事务内重验", async () => {
    const { app, state } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-race-key" },
      payload: { title: "竞态任务" },
    });
    state.enqueueParentInactive = true;
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-race-key" },
      payload: { input: "归档竞态输入" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("INVALID_STATE");
    expect(state.runs).toHaveLength(0);
  });

  it("Thread 归档后同键同载荷先重放原 Run，不同载荷固定冲突", async () => {
    const { app } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-replay-archived" },
      payload: { title: "归档后回放" },
    });
    const request = {
      method: "POST" as const,
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-replay-archived" },
      payload: { input: "同键原始输入" },
    };
    const first = await app.inject(request);
    expect(first.statusCode).toBe(200);
    await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer token-a" },
    });
    const replay = await app.inject(request);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data).toEqual(first.json().data);
    const conflict = await app.inject({ ...request, payload: { input: "归档后的不同输入" } });
    expect(conflict.statusCode).toBe(409);
  });

  it("Run 输入按 UTF-8 字节而非 UTF-16 字符数限制", async () => {
    const { app } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-input-limit" },
      payload: { title: "输入边界任务" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-input-limit-key" },
      // 单个 emoji 为 4 字节；字符数远小于 1 MiB，字节数却超过边界。
      payload: { input: "😀".repeat(262_145) },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("拒绝 trim 后为空的 Run 输入", async () => {
    const { app } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-blank-input" },
      payload: { title: "空白输入任务" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-blank-input-key" },
      payload: { input: " \n\t " },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("HTTP body 上限覆盖 1 MiB 解码输入的 JSON 转义，不以 wire 字节误拒绝", async () => {
    const { app } = fixture();
    openApps.push(app);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "thread-escaped-input" },
      payload: { title: "转义输入任务" },
    });
    // 每个 \u0001 在网络上占六字节，解析后仅占一个 UTF-8 字节。
    const escaped = "\\u0001".repeat(1_048_576);
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: {
        authorization: "Bearer token-a",
        "idempotency-key": "run-escaped-input-key",
        "content-type": "application/json",
      },
      payload: `{"input":"${escaped}"}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("queued");
  });

  it("超限请求体和无效游标只返回固定 ErrorEnvelope", async () => {
    const { dependencies } = fixture();
    const app = createApiApp(dependencies, { logger: false, bodyLimitBytes: 128 });
    openApps.push(app);
    const oversized = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "oversize-key" },
      payload: { title: "x".repeat(500) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(Object.keys(oversized.json())).toEqual(["version", "requestId", "error"]);
    const missingIdempotency = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a" },
      payload: { title: "缺少幂等键" },
    });
    expect(missingIdempotency.statusCode).toBe(400);
    const cursor = await app.inject({
      method: "GET",
      url: "/v1/threads?cursor=not-a-cursor",
      headers: { authorization: "Bearer token-a" },
    });
    expect(cursor.statusCode).toBe(400);
    expect(cursor.json().error).toEqual({
      code: "INVALID_REQUEST",
      message: "请求参数无效",
      retryable: false,
    });
  });

  it("创建能力必须显式签发，缺失时服务仍就绪且创建路由不存在", async () => {
    const { app, dependencies } = fixture({ enableCreate: false });
    openApps.push(app);
    expect((await app.inject({ method: "GET", url: "/ready" })).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/threads",
          headers: { authorization: "Bearer token-a", "idempotency-key": "disabled-key" },
          payload: { title: "不会创建" },
        })
      ).statusCode,
    ).toBe(404);
    expect(() =>
      createApiApp(
        {
          ...dependencies,
          createCapability: {
            threadCreation: {} as ThreadCreationPort,
            enqueueOutbox: {} as EnqueueOutboxPort,
          } as unknown as NonNullable<ApiDependencies["createCapability"]>,
        },
        { logger: false },
      ),
    ).toThrow("必须由 createApiCreateCapability 签发");
  });

  it("App 创建后替换依赖或能力端口，不会改变已注册路由使用的能力快照", async () => {
    const { dependencies, state } = fixture();
    const replacement = new FakeApiState();
    const mutableDependencies = { ...dependencies };
    let capabilityReads = 0;
    let issued = mutableDependencies.createCapability;
    Object.defineProperty(mutableDependencies, "createCapability", {
      configurable: true,
      enumerable: true,
      get: () => {
        capabilityReads += 1;
        return issued;
      },
      set: (value) => {
        issued = value;
      },
    });
    const app = createApiApp(mutableDependencies, { logger: false });
    openApps.push(app);
    mutableDependencies.createCapability = createApiCreateCapability({
      threadCreation: replacement,
      enqueueOutbox: replacement,
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "snapshot-key" },
      payload: { title: "能力快照" },
    });
    expect(response.statusCode).toBe(200);
    expect(capabilityReads).toBe(1);
    expect(state.threads.size).toBe(1);
    expect(replacement.threads.size).toBe(0);
  });

  it("命令端在事务边界重验成员资格，认证后的撤权不能产生 Thread 或 Run", async () => {
    const threadFixture = fixture();
    openApps.push(threadFixture.app);
    const scope = {
      tenantId: threadFixture.ownerA.tenant.id,
      userId: threadFixture.ownerA.user.id,
    };
    threadFixture.state.beforeThreadCreate = () => threadFixture.state.revokeCommands(scope);
    const deniedThread = await threadFixture.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "revoke-thread-key" },
      payload: { title: "撤权竞态" },
    });
    expect(deniedThread.statusCode).toBe(404);
    expect(threadFixture.state.threads.size).toBe(0);

    const runFixture = fixture();
    openApps.push(runFixture.app);
    await runFixture.app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer token-a", "idempotency-key": "run-parent-key" },
      payload: { title: "Run 父任务" },
    });
    const runScope = { tenantId: runFixture.ownerA.tenant.id, userId: runFixture.ownerA.user.id };
    runFixture.state.beforeRunCreate = () => runFixture.state.revokeCommands(runScope);
    const deniedRun = await runFixture.app.inject({
      method: "POST",
      url: "/v1/threads/thread_1/runs",
      headers: { authorization: "Bearer token-a", "idempotency-key": "revoke-run-key" },
      payload: { input: "撤权竞态输入" },
    });
    expect(deniedRun.statusCode).toBe(404);
    expect(runFixture.state.runs.size).toBe(0);
  });

  it("归档命令在锁内重验角色，认证后的降权不能归档", async () => {
    const { app, state } = fixture();
    openApps.push(app);
    const ownerUser = createUser(userId("user_race_owner"), baseTime);
    const raceTenant = rehydrateTenant(
      {
        id: "tenant_race",
        kind: "team",
        displayName: "竞态测试团队",
        createdByUserId: ownerUser.id,
        createdAt: baseTime,
      },
      ownerUser,
    );
    const owner = teamBundle({
      suffix: "race_owner",
      tenant: raceTenant,
      user: ownerUser,
      role: "owner",
    });
    const adminUser = createUser(userId("user_race_admin"), baseTime);
    const admin = teamBundle({
      suffix: "race_admin",
      tenant: owner.tenant,
      user: adminUser,
      role: "admin",
    });
    state.register("Bearer race-owner", owner);
    state.register("Bearer race-admin", admin);
    await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: { authorization: "Bearer race-owner", "idempotency-key": "archive-race-parent" },
      payload: { title: "归档竞态" },
    });
    const adminScope = { tenantId: admin.tenant.id, userId: admin.user.id };
    state.beforeArchive = () => state.overrideRole(adminScope, "member");
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/threads/thread_1",
      headers: { authorization: "Bearer race-admin" },
    });
    expect(response.statusCode).toBe(404);
    expect(state.threads.get(`${owner.tenant.id}:thread_1`)?.entity.status).toBe("active");
  });

  it("畸形 JSON、错误媒体类型和原型污染键均返回固定错误信封", async () => {
    const { app } = fixture();
    openApps.push(app);
    const headers = {
      authorization: "Bearer token-a",
      "idempotency-key": "raw-payload-key",
      "content-type": "application/json",
    };
    for (const payload of [
      '{"title":',
      '{"title":"原型键","__proto__":{"polluted":true}}',
      '{"title":"构造器键","constructor":{"prototype":{"polluted":true}}}',
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/threads", headers, payload });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
      expect(Object.keys(response.json())).toEqual(["version", "requestId", "error"]);
    }
    expect((Object.prototype as { polluted?: unknown }).polluted).toBeUndefined();

    const media = await app.inject({
      method: "POST",
      url: "/v1/threads",
      headers: {
        authorization: "Bearer token-a",
        "idempotency-key": "media-type-key",
        "content-type": "text/plain",
      },
      payload: "plain text",
    });
    expect(media.statusCode).toBe(415);
    expect(media.json().error).toEqual({
      code: "UNSUPPORTED_MEDIA_TYPE",
      message: "不支持的媒体类型",
      retryable: false,
    });
  });

  it("签名游标拒绝篡改、跨租户和同租户跨用户重放", async () => {
    const { app, state } = fixture();
    openApps.push(app);
    for (const [keyValue, title] of [
      ["cursor-bind-key-1", "第一页"],
      ["cursor-bind-key-2", "第二页"],
    ]) {
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: { authorization: "Bearer token-a", "idempotency-key": keyValue },
        payload: { title },
      });
    }
    const page = await app.inject({
      method: "GET",
      url: "/v1/threads?limit=1",
      headers: { authorization: "Bearer token-a" },
    });
    const cursorValue = page.json().data.nextCursor as string;
    const tampered = `${cursorValue.slice(0, -1)}${cursorValue.endsWith("A") ? "B" : "A"}`;
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/threads?cursor=${encodeURIComponent(tampered)}`,
          headers: { authorization: "Bearer token-a" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/threads?cursor=${encodeURIComponent(cursorValue)}`,
          headers: { authorization: "Bearer token-b" },
        })
      ).statusCode,
    ).toBe(400);

    const teamCreator = createUser(userId("user_cursor_team_owner"), baseTime);
    const teamTenant = rehydrateTenant(
      {
        id: "tenant_cursor_team",
        kind: "team",
        displayName: "游标绑定团队",
        createdByUserId: teamCreator.id,
        createdAt: baseTime,
      },
      teamCreator,
    );
    const teamOwner = teamBundle({
      suffix: "cursor_team_owner",
      tenant: teamTenant,
      user: teamCreator,
      role: "owner",
    });
    state.register("Bearer cursor-team-owner", teamOwner);
    for (const [keyValue, title] of [
      ["cursor-team-key-1", "团队第一页"],
      ["cursor-team-key-2", "团队第二页"],
    ]) {
      await app.inject({
        method: "POST",
        url: "/v1/threads",
        headers: { authorization: "Bearer cursor-team-owner", "idempotency-key": keyValue },
        payload: { title },
      });
    }
    const teamPage = await app.inject({
      method: "GET",
      url: "/v1/threads?limit=1",
      headers: { authorization: "Bearer cursor-team-owner" },
    });
    const teamCursor = teamPage.json().data.nextCursor as string;
    const secondUser = createUser(userId("user_same_tenant"), baseTime);
    const member = teamBundle({
      suffix: "same_tenant",
      tenant: teamTenant,
      user: secondUser,
      role: "member",
    });
    state.register("Bearer same-tenant", member);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/v1/threads?cursor=${encodeURIComponent(teamCursor)}`,
          headers: { authorization: "Bearer same-tenant" },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("Thread 游标签名密钥轮换", () => {
  const oldSecret = Buffer.alloc(32, 1).toString("base64url");
  const newSecret = Buffer.alloc(32, 2).toString("base64url");
  const scope = { tenantId: tenantId("tenant_cursor"), userId: userId("user_cursor") };
  const cursor = { updatedAt: baseTime, id: threadId("thread_cursor") };
  let now = baseTime;
  const clock = { now: () => now };
  const timing = { clock, ttlMilliseconds: 10_000, maximumTtlMilliseconds: 10_000 };

  it("轮换期读取旧 kid、新写入使用 active kid，移除旧 key 后拒绝旧游标", () => {
    const oldCodec = createThreadCursorCodec({
      activeKid: "key-old",
      keys: [{ kid: "key-old", secret: oldSecret }],
      ...timing,
    });
    const oldToken = oldCodec.encode(scope, cursor);
    const rotated = createThreadCursorCodec({
      activeKid: "key-new",
      keys: [
        { kid: "key-old", secret: oldSecret },
        { kid: "key-new", secret: newSecret },
      ],
      ...timing,
    });
    now = isoTimestamp("2099-07-26T08:00:05.000Z");
    expect(rotated.decode(scope, oldToken)).toEqual(cursor);
    const newToken = rotated.encode(scope, cursor);
    const encodedPayload = newToken.split(".")[0];
    if (encodedPayload === undefined) throw new Error("测试游标缺少载荷");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    expect(payload).toMatchObject({
      v: 1,
      kid: "key-new",
      ...scope,
      issuedAt: now,
      expiresAt: "2099-07-26T08:00:15.000Z",
      ...cursor,
    });
    now = isoTimestamp("2099-07-26T08:00:10.000Z");
    expect(() => rotated.decode(scope, oldToken)).toThrow("任务分页游标无效");
    const retired = createThreadCursorCodec({
      activeKid: "key-new",
      keys: [{ kid: "key-new", secret: newSecret }],
      ...timing,
    });
    expect(() => retired.decode(scope, oldToken)).toThrow("任务分页游标无效");
  });

  it("拒绝未来签发时间和超过本地最大寿命的有效签名游标", () => {
    now = baseTime;
    const futureClock = { now: () => isoTimestamp("2099-07-26T08:00:01.000Z") };
    const futureSigner = createThreadCursorCodec({
      activeKid: "key-old",
      keys: [{ kid: "key-old", secret: oldSecret }],
      clock: futureClock,
      ttlMilliseconds: 10_000,
      maximumTtlMilliseconds: 20_000,
    });
    const verifier = createThreadCursorCodec({
      activeKid: "key-old",
      keys: [{ kid: "key-old", secret: oldSecret }],
      ...timing,
    });
    expect(() => verifier.decode(scope, futureSigner.encode(scope, cursor))).toThrow(
      "任务分页游标无效",
    );

    const longLivedSigner = createThreadCursorCodec({
      activeKid: "key-old",
      keys: [{ kid: "key-old", secret: oldSecret }],
      clock,
      ttlMilliseconds: 20_000,
      maximumTtlMilliseconds: 20_000,
    });
    expect(() => verifier.decode(scope, longLivedSigner.encode(scope, cursor))).toThrow(
      "任务分页游标无效",
    );
  });

  it("拒绝弱密钥、重复 kid 和不存在的 active kid", () => {
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-old",
        keys: [{ kid: "key-old", secret: Buffer.alloc(16).toString("base64url") }],
        ...timing,
      }),
    ).toThrow("32 到 64 字节");
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-old",
        keys: [
          { kid: "key-old", secret: oldSecret },
          { kid: "key-old", secret: newSecret },
        ],
        ...timing,
      }),
    ).toThrow("无效或重复");
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-new",
        keys: [{ kid: "key-old", secret: oldSecret }],
        ...timing,
      }),
    ).toThrow("当前签名密钥不存在");
  });

  it("协议允许的最大 ID 可往返，超过推导载荷上限的输入被拒绝", () => {
    now = baseTime;
    const maximumScope = {
      tenantId: tenantId(`t${"a".repeat(127)}`),
      userId: userId(`u${"b".repeat(127)}`),
    };
    const maximumCursor = {
      updatedAt: baseTime,
      id: threadId(`i${"c".repeat(127)}`),
    };
    const codec = createThreadCursorCodec({
      activeKid: "k".repeat(32),
      keys: [{ kid: "k".repeat(32), secret: oldSecret }],
      ...timing,
    });
    const token = codec.encode(maximumScope, maximumCursor);
    expect(token.length).toBeGreaterThan(512);
    expect(codec.decode(maximumScope, token)).toEqual(maximumCursor);

    const oversizedScope = {
      ...maximumScope,
      tenantId: `t${"a".repeat(128)}` as typeof maximumScope.tenantId,
    };
    expect(() => codec.encode(oversizedScope, maximumCursor)).toThrow("任务分页游标无效");
    expect(() => codec.decode(maximumScope, "a".repeat(2_000))).toThrow("任务分页游标无效");
  });
});
