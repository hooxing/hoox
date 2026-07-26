import {
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

const baseTime = isoTimestamp("2099-07-26T08:00:00.000Z");

function key(scope: TenantScope, id: string): string {
  return `${scope.tenantId}:${id}`;
}

class FakeApiState implements ThreadCreationPort, EnqueueOutboxPort {
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

  async createThread(input: {
    readonly scope: TenantScope;
    readonly thread: Thread;
    readonly workspace: Workspace;
    readonly idempotency: IdempotentCommand;
  }): Promise<IdempotentCreateResult<Thread>> {
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
    if (this.enqueueParentInactive) return { outcome: "parent_inactive" };
    const parent = this.threads.get(key(input.scope, input.run.threadId));
    if (parent?.entity.status !== "active") return { outcome: "parent_inactive" };
    return this.idempotent(input.scope, "run", input.idempotency, input.run, () => {
      this.runs.set(key(input.scope, input.run.id), { entity: input.run, version: 0n });
    });
  }

  private idempotent<T extends Thread | Run>(
    scope: TenantScope,
    operation: string,
    command: IdempotentCommand,
    entity: T,
    commit: () => void,
  ): IdempotentCreateResult<T> {
    const commandKey = `${scope.tenantId}:${scope.userId}:${operation}:${command.key}`;
    const existing = this.idempotency.get(commandKey);
    if (existing !== undefined) {
      return existing.hash === command.requestHash
        ? { outcome: "replayed", entity: existing.entity as T }
        : { outcome: "key_conflict" };
    }
    commit();
    this.idempotency.set(commandKey, { hash: command.requestHash, entity });
    return { outcome: "created", entity };
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

function fixture() {
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
    threadCreation: state,
    enqueueOutbox: state,
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
    const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
    expect(first.json().data).toMatchObject({ id: "run_1", status: "queued" });
    expect(second.json().data.id).toBe("run_1");
    expect(state.runs).toHaveLength(1);

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
      code: "BAD_REQUEST",
      message: "请求参数无效",
      retryable: false,
    });
  });
});
