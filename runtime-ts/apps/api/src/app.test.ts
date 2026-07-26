import {
  archiveThread,
  createMembership,
  createPersonalTenant,
  createUser,
  isoTimestamp,
  membershipId,
  rehydrateTenant,
  runId,
  tenantId,
  threadId,
  userId,
  workspaceId,
  type IsoTimestamp,
  type MembershipRole,
  type Run,
  type Tenant,
  type Thread,
  type User,
  type Workspace,
} from "@cube-runtime/domain";
import type {
  ArchiveThreadCommandPort,
  CoreRepositories,
  TenantBundle,
  TenantScope,
  ThreadListPage,
  Versioned,
} from "@cube-runtime/persistence";
import { afterEach, describe, expect, it } from "vitest";
import { createApiApp, type ApiDependencies } from "./app.js";
import type {
  AuthPrincipal,
  EnqueueOutboxPort,
  IdempotentCommand,
  IdempotentCreateResult,
  ThreadCreationPort,
} from "./ports.js";
import { createApiCreateCapability } from "./capabilities.js";
import { createThreadCursorCodec } from "./cursor.js";

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
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Run>> {
    await this.beforeRunCreate?.();
    return this.idempotent(input.scope, "run", input.idempotency, input.run, () => {
      this.runs.set(key(input.scope, input.run.id), { entity: input.run, version: 0n });
    });
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
      const entity = archiveThread(current.entity, input.now);
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

function fixture(options: { readonly enableCreate?: boolean } = {}) {
  const state = new FakeApiState();
  const ownerA = personalBundle("owner_a");
  const ownerB = personalBundle("owner_b");
  state.register("Bearer token-a", ownerA);
  state.register("Bearer token-b", ownerB);
  let threadSequence = 0;
  let runSequence = 0;
  let workspaceSequence = 0;
  const dependencies: ApiDependencies = {
    auth: {
      resolve: async ({ authorization }) =>
        authorization === undefined ? undefined : state.principals.get(authorization),
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
    }),
    readiness: { probe: async () => undefined },
    clock: new FakeClock(),
    ids: {
      thread: () => threadId(`thread_${++threadSequence}`),
      run: () => runId(`run_${++runSequence}`),
      workspace: () => workspaceId(`workspace_${++workspaceSequence}`),
    },
  };
  const app = createApiApp(dependencies, { logger: false });
  return { app, state, dependencies, ownerA, ownerB };
}

const openApps: { close(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("Fastify API 契约", () => {
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
      payload: {},
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
      payload: {},
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("INVALID_STATE");
    expect(state.runs).toHaveLength(0);
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
      payload: {},
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

  it("轮换期读取旧 kid、新写入使用 active kid，移除旧 key 后拒绝旧游标", () => {
    const oldCodec = createThreadCursorCodec({
      activeKid: "key-old",
      keys: [{ kid: "key-old", secret: oldSecret }],
    });
    const oldToken = oldCodec.encode(scope, cursor);
    const rotated = createThreadCursorCodec({
      activeKid: "key-new",
      keys: [
        { kid: "key-old", secret: oldSecret },
        { kid: "key-new", secret: newSecret },
      ],
    });
    expect(rotated.decode(scope, oldToken)).toEqual(cursor);
    const newToken = rotated.encode(scope, cursor);
    const encodedPayload = newToken.split(".")[0];
    if (encodedPayload === undefined) throw new Error("测试游标缺少载荷");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    expect(payload).toMatchObject({ v: 1, kid: "key-new", ...scope, ...cursor });
    const retired = createThreadCursorCodec({
      activeKid: "key-new",
      keys: [{ kid: "key-new", secret: newSecret }],
    });
    expect(() => retired.decode(scope, oldToken)).toThrow("任务分页游标无效");
  });

  it("拒绝弱密钥、重复 kid 和不存在的 active kid", () => {
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-old",
        keys: [{ kid: "key-old", secret: Buffer.alloc(16).toString("base64url") }],
      }),
    ).toThrow("32 到 64 字节");
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-old",
        keys: [
          { kid: "key-old", secret: oldSecret },
          { kid: "key-old", secret: newSecret },
        ],
      }),
    ).toThrow("无效或重复");
    expect(() =>
      createThreadCursorCodec({
        activeKid: "key-new",
        keys: [{ kid: "key-old", secret: oldSecret }],
      }),
    ).toThrow("当前签名密钥不存在");
  });
});
