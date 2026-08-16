import { randomUUID } from "node:crypto";
import type {
  PgClaimedRunDispatch,
  PgClaimedWorkerTenantAssignment,
  PgRunDispatchOutbox,
  PgWorkerTenantAssignments,
} from "@aisay/persistence";
import type {
  ArtifactPublicationPort,
  CancellationPort,
  ClockPort,
  ExecutionScope,
  HeartbeatTask,
  OrphanSandboxCleanupPort,
  SandboxAcquireResult,
  SandboxSessionRef,
  SandboxSessionRegistryPort,
  SandboxSettlementResult,
  ScheduledTask,
  ThreadSandboxProviderPort,
  WorkspaceRevisionVerifierPort,
} from "@aisay/run-contracts";
import {
  type CubeGatewayOptions,
  CubeSandboxGateway,
  type E2BGatewayOptions,
  E2BSandboxGateway,
  type OperationControl,
  type RuntimeSandboxGateway,
  type SandboxProviderKey,
  SandboxRuntimeError,
  type SandboxWorkspaceAdapterOptions,
  type SandboxWorkspacePort,
  type TenantResourceVolumePort,
  type TrustedSandboxSessionCapability,
  type UncertainLifecycleEvent,
} from "@aisay/sandbox";
import type { RunWorker, RunWorkerResult } from "./run-worker.js";
import type { SandboxResourceFilesystemMaterializerPort } from "./sandbox-resource-filesystem-materializer.js";

const SANDBOX_PREFLIGHT_SIGNAL = new AbortController().signal;

export class SystemWorkerClock implements ClockPort {
  schedule(delayMs: number, callback: () => void): ScheduledTask {
    const timer = setTimeout(callback, delayMs);
    return Object.freeze({ cancel: () => clearTimeout(timer) });
  }

  startHeartbeat(intervalMs: number, callback: () => Promise<void>): HeartbeatTask {
    let stopped = false;
    let active = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped) return;
      active = active.then(callback);
    }, intervalMs);
    return Object.freeze({
      async stop() {
        stopped = true;
        clearInterval(timer);
        await active;
      },
    });
  }
}

/** 业务取消由 PostgreSQL Run 状态提供；进程信号绝不能伪装成用户取消。 */
export class DatabaseRunCancellation implements CancellationPort {
  private readonly entries = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly timer: NodeJS.Timeout;
      released: boolean;
      probeInFlight: boolean;
    }
  >();

  constructor(
    private readonly isCancelled: (scope: ExecutionScope) => Promise<boolean> = async () => false,
    private readonly pollIntervalMs = 1_000,
  ) {
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
      throw new TypeError("Run 取消轮询间隔无效");
    }
  }

  signalFor(scope: ExecutionScope): AbortSignal {
    const key = cancellationKey(scope);
    const existing = this.entries.get(key);
    if (existing !== undefined) return existing.controller.signal;

    const controller = new AbortController();
    const entry = {
      controller,
      timer: undefined as unknown as NodeJS.Timeout,
      released: false,
      probeInFlight: false,
    };
    const probe = async () => {
      if (entry.released || entry.probeInFlight || controller.signal.aborted) return;
      entry.probeInFlight = true;
      try {
        if ((await this.isCancelled(scope)) && !entry.released) {
          controller.abort("run_cancelled");
        }
      } catch {
        // 短暂数据库故障不能伪造取消；下一轮继续探测，租约心跳仍负责 fail-closed。
      } finally {
        entry.probeInFlight = false;
      }
    };
    entry.timer = setInterval(() => void probe(), this.pollIntervalMs);
    entry.timer.unref();
    this.entries.set(key, entry);
    void probe();
    return controller.signal;
  }

  release(scope: ExecutionScope): void {
    const key = cancellationKey(scope);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    entry.released = true;
    clearInterval(entry.timer);
    this.entries.delete(key);
  }
}

function cancellationKey(scope: ExecutionScope): string {
  return `${scope.tenantId}\u0000${scope.runId}`;
}

export class ProcessShutdown {
  private readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  request(): void {
    this.controller.abort(new Error("Agent Worker 正在关闭"));
  }
}

/**
 * 发布的候选引用尚未能与 RuntimeMutation 原子交接时，生产 Worker 必须保持 fail-closed。
 * 这一检查放在模型 Session 创建之前：模板残留、上次执行残留或 /workspace 缺失都不能被模型
 * 读取，更不能在后续 verify 中被误当成用户变更发布。
 */
export class FailClosedWorkspaceRevisionVerifier implements WorkspaceRevisionVerifierPort {
  async materialize(
    input: Parameters<WorkspaceRevisionVerifierPort["materialize"]>[0],
  ): Promise<void> {
    // 空目录 verifier 不具备将 committed head 物化为 Sandbox 的能力。带 checkpoint 仍继续执行
    // 会让模型在空目录中工作并把文件静默丢失，因此必须在模型前拒绝。
    if (input.expectedCurrentRevisionId !== undefined) {
      throw new Error("WORKSPACE_REVISION_MATERIALIZATION_REQUIRED");
    }
    await assertEmptyWorkspaceRoot(input.sandbox);
  }

  async verify(input: Parameters<WorkspaceRevisionVerifierPort["verify"]>[0]): Promise<undefined> {
    // Session 内模型/工具可能写入文件；模型结束后的再次检查保证不会把未发布内容成功关闭。
    await assertEmptyWorkspaceRoot(input.sandbox);
    return undefined;
  }
}

async function assertEmptyWorkspaceRoot(session: SandboxSessionRef): Promise<void> {
  const result = await session.sandbox.command(
    `if [ ! -d /workspace ] || [ -L /workspace ]; then exit 72; fi
if ! workspace_entry=$(find -P /workspace -mindepth 1 -print -quit); then exit 74; fi
if [ -n "$workspace_entry" ]; then exit 73; fi`,
  );
  if (result.exitCode !== 0) throw new Error("WORKSPACE_REVISION_PUBLICATION_REQUIRED");
}

interface SandboxSessionInitializerPort {
  initialize(input: {
    readonly sandbox: SandboxSessionRef["sandbox"];
    readonly signal: AbortSignal;
  }): Promise<void>;
}

class E2BSandboxBaselineInitializer implements SandboxSessionInitializerPort {
  constructor(private readonly timeoutMs: number) {}

  async initialize(input: {
    readonly sandbox: SandboxSessionRef["sandbox"];
    readonly signal: AbortSignal;
  }): Promise<void> {
    const result = await input.sandbox.command(
      `set -eu
if [ -L /workspace ]; then exit 72; fi
uid=$(id -u)
gid=$(id -g)
sudo install -d -o "$uid" -g "$gid" -m 0700 /workspace
[ -d /workspace ]
[ ! -L /workspace ]`,
      { signal: input.signal, timeoutMs: this.timeoutMs },
    );
    if (result.exitCode !== 0 || result.stderr !== "") {
      throw new SandboxRuntimeError("PROTOCOL", "E2B Workspace 根目录初始化失败");
    }
  }
}

/** Provider 无关的生产 Session registry；PG 包装器会在返回 Worker 前提交 registry 事实。 */
export class ProviderSandboxSessionRegistry
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort, ThreadSandboxProviderPort
{
  private uncertainCreate: UncertainLifecycleEvent | undefined;
  /**
   * Workspace capability 不只绑定对象身份：必须绑定 acquire 时已经由 Run fence 审核过的完整
   * ExecutionScope。否则攻击者可把同一 SandboxSessionRef 重放到另一 tenant/thread/workspace。
   */
  private readonly workspaceBindings = new WeakMap<object, WorkspaceCapabilityBinding>();

  constructor(
    readonly gateway: RuntimeSandboxGateway,
    private readonly templateId: string,
    private readonly ttlSeconds = 120,
    private readonly lifecycleTimeoutMs = 90_000,
    private readonly resourceVolume?: TenantResourceVolumePort,
    private readonly resourceFilesystemMaterializer?: SandboxResourceFilesystemMaterializerPort,
    private readonly sandboxInitializer?: SandboxSessionInitializerPort,
    private readonly uncertainEvents?: { current: UncertainLifecycleEvent | undefined },
  ) {
    if (
      !Number.isSafeInteger(lifecycleTimeoutMs) ||
      lifecycleTimeoutMs < 1 ||
      lifecycleTimeoutMs > 600_000
    ) {
      throw new TypeError("Sandbox lifecycle timeout 无效");
    }
  }

  get defaultProviderKey(): SandboxProviderKey {
    return this.gateway.providerKey;
  }

  async probe(): Promise<void> {
    await Promise.all([this.gateway.probe(), this.resourceVolume?.probe()]);
  }

  /** 开发预检必须覆盖真实模板调度与数据面命令，避免管理面健康掩盖不可执行节点。 */
  async probeExecution(): Promise<void> {
    await this.probe();
    const sandbox = await this.gateway.create(
      { templateId: this.templateId, ttlSeconds: Math.min(this.ttlSeconds, 30) },
      { timeoutMs: this.lifecycleTimeoutMs },
    );
    try {
      await this.sandboxInitializer?.initialize({ sandbox, signal: SANDBOX_PREFLIGHT_SIGNAL });
      const output = await sandbox.command("printf aisay-runtime-sandbox-ready", {
        timeoutMs: Math.min(this.lifecycleTimeoutMs, 5_000),
      });
      if (
        output.exitCode !== 0 ||
        output.stderr !== "" ||
        output.stdout !== "aisay-runtime-sandbox-ready"
      ) {
        throw new SandboxRuntimeError("PROTOCOL", "Sandbox 开发执行预检返回异常结果");
      }
    } finally {
      await sandbox.kill({ timeoutMs: this.lifecycleTimeoutMs, ignoreNotFound: true });
    }
  }

  async acquire(input: {
    readonly scope: ExecutionScope;
    readonly signal: AbortSignal;
    readonly requiresResourceFilesystem: boolean;
  }): Promise<SandboxAcquireResult> {
    this.uncertainCreate = undefined;
    if (this.uncertainEvents !== undefined) this.uncertainEvents.current = undefined;
    try {
      if (
        input.requiresResourceFilesystem &&
        this.resourceVolume === undefined &&
        this.resourceFilesystemMaterializer === undefined
      ) {
        throw new Error("ResourceFS provider 未配置");
      }
      const volume = input.requiresResourceFilesystem
        ? await this.resourceVolume?.ensure({
            tenantId: input.scope.tenantId,
            signal: input.signal,
          })
        : undefined;
      const sandbox = await this.gateway.create(
        {
          templateId: this.templateId,
          ttlSeconds: this.ttlSeconds,
          ...(volume === undefined ? {} : { volumeMounts: [volume] }),
        },
        { signal: input.signal, timeoutMs: this.lifecycleTimeoutMs },
      );
      await this.prepareCreatedSandbox(
        input.scope,
        sandbox,
        input.signal,
        input.requiresResourceFilesystem,
      );
      const session = this.bindSession(input.scope, `registry-${randomUUID()}`, sandbox, "created");
      return { outcome: "ready", session };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "UNKNOWN") {
        return {
          outcome: "unknown",
          event:
            this.uncertainCreate ??
            this.uncertainEvents?.current ??
            fallbackUncertainEvent(
              this.gateway.providerKey,
              `create-${randomUUID()}`,
              this.ttlSeconds,
            ),
        };
      }
      return { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  async create(
    input: Parameters<ThreadSandboxProviderPort["create"]>[0],
  ): Promise<SandboxAcquireResult> {
    this.uncertainCreate = undefined;
    if (this.uncertainEvents !== undefined) this.uncertainEvents.current = undefined;
    try {
      if (
        input.requiresResourceFilesystem &&
        this.resourceVolume === undefined &&
        this.resourceFilesystemMaterializer === undefined
      ) {
        throw new Error("ResourceFS provider 未配置");
      }
      const volume = input.requiresResourceFilesystem
        ? await this.resourceVolume?.ensure({
            tenantId: input.scope.tenantId,
            signal: input.signal,
          })
        : undefined;
      const sandbox = await this.gateway.create(
        {
          templateId: this.templateId,
          ttlSeconds: this.ttlSeconds,
          lifecycle: { onTimeout: "pause", autoResume: true },
          ...(volume === undefined ? {} : { volumeMounts: [volume] }),
        },
        { signal: input.signal, timeoutMs: this.lifecycleTimeoutMs },
      );
      await this.prepareCreatedSandbox(
        input.scope,
        sandbox,
        input.signal,
        input.requiresResourceFilesystem,
      );
      return {
        outcome: "ready",
        session: this.bindSession(input.scope, input.registryId, sandbox, "created"),
      };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "UNKNOWN") {
        return {
          outcome: "unknown",
          event:
            this.uncertainCreate ??
            this.uncertainEvents?.current ??
            fallbackUncertainEvent(
              this.gateway.providerKey,
              `create-${randomUUID()}`,
              this.ttlSeconds,
            ),
        };
      }
      return { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  private async prepareCreatedSandbox(
    scope: ExecutionScope,
    sandbox: SandboxSessionRef["sandbox"],
    signal: AbortSignal,
    requiresResourceFilesystem: boolean,
  ): Promise<void> {
    try {
      await this.sandboxInitializer?.initialize({ sandbox, signal });
      if (requiresResourceFilesystem) {
        await this.resourceFilesystemMaterializer?.materialize({ scope, sandbox, signal });
      }
    } catch (error) {
      console.warn(`SANDBOX_PREPARE_FAILED category=${sandboxFailureCategory(error)}`);
      try {
        await sandbox.kill({ timeoutMs: this.lifecycleTimeoutMs, ignoreNotFound: true });
      } catch (cleanupError) {
        console.warn(
          `SANDBOX_PREPARE_CLEANUP_FAILED category=${sandboxFailureCategory(cleanupError)}`,
        );
        const event = fallbackUncertainEvent(
          this.gateway.providerKey,
          `prepare-${randomUUID()}`,
          this.ttlSeconds,
          sandbox.id,
        );
        this.uncertainCreate = event;
        if (this.uncertainEvents !== undefined) this.uncertainEvents.current = event;
        throw new SandboxRuntimeError("UNKNOWN", "Sandbox 初始化失败且清理结果未知", cleanupError);
      }
      throw error;
    }
  }

  async connect(
    input: Parameters<ThreadSandboxProviderPort["connect"]>[0],
  ): Promise<SandboxAcquireResult | { readonly outcome: "not_found" }> {
    if (input.providerKey !== this.gateway.providerKey) {
      throw new Error(`Sandbox Provider 路由不匹配: ${input.providerKey}`);
    }
    try {
      const sandbox = await this.gateway.connect(input.providerSandboxId, {
        signal: input.signal,
        timeoutMs: this.lifecycleTimeoutMs,
      });
      await this.sandboxInitializer?.initialize({ sandbox, signal: input.signal });
      if (this.resourceFilesystemMaterializer !== undefined) {
        await this.resourceFilesystemMaterializer.materialize({
          scope: input.scope,
          sandbox,
          signal: input.signal,
        });
      }
      return {
        outcome: "ready",
        session: this.bindSession(input.scope, input.registryId, sandbox, "connected"),
      };
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === "NOT_FOUND") {
        return { outcome: "not_found" };
      }
      return error instanceof SandboxRuntimeError && error.code === "TIMEOUT"
        ? {
            outcome: "unknown",
            event: fallbackUncertainEvent(
              this.gateway.providerKey,
              input.registryId,
              this.ttlSeconds,
            ),
          }
        : { outcome: "failed", code: "SANDBOX_FAILED" };
    }
  }

  async settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    try {
      if (input.disposition === "pause") {
        await input.session.sandbox.pause({ timeoutMs: this.lifecycleTimeoutMs });
      } else {
        await input.session.sandbox.kill({
          timeoutMs: this.lifecycleTimeoutMs,
          ignoreNotFound: true,
        });
      }
      return { outcome: "settled" };
    } catch {
      return {
        outcome: "unknown",
        event: fallbackUncertainEvent(
          input.session.providerKey,
          input.cleanupIntentId,
          this.ttlSeconds,
          input.session.providerSandboxId,
        ),
      };
    }
  }

  closeOrphan(
    input: Parameters<OrphanSandboxCleanupPort["closeOrphan"]>[0],
  ): Promise<SandboxSettlementResult> {
    return this.settle({
      ...input,
      cleanupIntentId: `registry:${input.session.registryId}:orphan-cleanup`,
      disposition: "close",
    });
  }

  private bindSession(
    scope: ExecutionScope,
    registryId: string,
    sandbox: SandboxSessionRef["sandbox"],
    mode: SandboxSessionRef["mode"],
  ): SandboxSessionRef {
    const session: SandboxSessionRef = Object.freeze({
      registryId,
      providerKey: this.gateway.providerKey,
      providerSandboxId: sandbox.id,
      mode,
      sandbox,
    });
    this.workspaceBindings.set(
      session,
      Object.freeze({
        registryId,
        providerKey: this.gateway.providerKey,
        providerSandboxId: sandbox.id,
        scope: freezeExecutionScope(scope),
      }),
    );
    return session;
  }

  workspaceCapability(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
  }): TrustedSandboxSessionCapability {
    const recorded = this.workspaceBindings.get(input.session);
    if (
      recorded === undefined ||
      recorded.registryId !== input.session.registryId ||
      recorded.providerKey !== input.session.providerKey ||
      recorded.providerSandboxId !== input.session.providerSandboxId ||
      input.session.sandbox.id !== input.session.providerSandboxId ||
      !sameExecutionScope(recorded.scope, input.scope)
    ) {
      throw new Error("未授予 Sandbox Workspace capability");
    }
    const binding = Object.freeze({
      sessionId: recorded.providerSandboxId,
      generation: 1,
      scope: Object.freeze({
        tenantId: recorded.scope.tenantId,
        threadId: recorded.scope.threadId,
        workspaceId: recorded.scope.workspaceId,
      }),
    });
    return Object.freeze({
      async current() {
        // 不能回读调用方可变对象；上面的 capability 已在 registry 私有 WeakSet 中完成对象身份校验。
        return binding;
      },
    });
  }
}

export class CubeSandboxSessionRegistry extends ProviderSandboxSessionRegistry {
  constructor(
    options: CubeGatewayOptions,
    templateId: string,
    ttlSeconds = 120,
    lifecycleTimeoutMs = 90_000,
    resourceVolume?: TenantResourceVolumePort,
  ) {
    const uncertainEvents: { current: UncertainLifecycleEvent | undefined } = {
      current: undefined,
    };
    const gateway = new CubeSandboxGateway({
      ...options,
      maxCreateTtlSeconds: ttlSeconds,
      timeout: ttlSeconds,
      onUncertainLifecycle: (event) => {
        uncertainEvents.current = event;
      },
    });
    super(
      gateway,
      templateId,
      ttlSeconds,
      lifecycleTimeoutMs,
      resourceVolume,
      undefined,
      undefined,
      uncertainEvents,
    );
  }
}

export class E2BSandboxSessionRegistry extends ProviderSandboxSessionRegistry {
  constructor(
    options: E2BGatewayOptions,
    templateId: string,
    ttlSeconds = 120,
    lifecycleTimeoutMs = 90_000,
    resourceFilesystemMaterializer?: SandboxResourceFilesystemMaterializerPort,
  ) {
    const uncertainEvents: { current: UncertainLifecycleEvent | undefined } = {
      current: undefined,
    };
    const gateway = new E2BSandboxGateway({
      ...options,
      maxCreateTtlSeconds: ttlSeconds,
      connectTtlSeconds: ttlSeconds,
      onUncertainLifecycle: (event) => {
        uncertainEvents.current = event;
      },
    });
    // 受控快照只把 Tenant RLS 已授权的业务字节写入 E2B，不向 Sandbox 暴露数据库、S3 或签名凭据。
    super(
      gateway,
      templateId,
      ttlSeconds,
      lifecycleTimeoutMs,
      undefined,
      resourceFilesystemMaterializer,
      new E2BSandboxBaselineInitializer(lifecycleTimeoutMs),
      uncertainEvents,
    );
  }
}
function sandboxFailureCategory(error: unknown): string {
  if (error instanceof SandboxRuntimeError) return error.code.toLowerCase();
  if (error instanceof Error && error.name.trim().length > 0) {
    return error.name.replaceAll(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
  }
  return "unknown";
}

/** 部署级 Session Router；创建走默认 Provider，恢复与清理严格使用持久化 providerKey。 */
export class SandboxSessionRegistryRouter
  implements SandboxSessionRegistryPort, OrphanSandboxCleanupPort, ThreadSandboxProviderPort
{
  private readonly registries: ReadonlyMap<SandboxProviderKey, ProviderSandboxSessionRegistry>;
  private readonly workspaceOwners = new WeakMap<object, ProviderSandboxSessionRegistry>();

  constructor(
    readonly defaultProviderKey: SandboxProviderKey,
    registries: readonly ProviderSandboxSessionRegistry[],
  ) {
    const indexed = new Map<SandboxProviderKey, ProviderSandboxSessionRegistry>();
    for (const registry of registries) {
      if (indexed.has(registry.gateway.providerKey))
        throw new TypeError("Sandbox Provider registry 重复");
      indexed.set(registry.gateway.providerKey, registry);
    }
    if (!indexed.has(defaultProviderKey)) throw new TypeError("默认 Sandbox Provider 未启用");
    this.registries = indexed;
  }

  private require(providerKey: SandboxProviderKey): ProviderSandboxSessionRegistry {
    const registry = this.registries.get(providerKey);
    if (registry === undefined) throw new Error(`Sandbox Provider 未启用: ${providerKey}`);
    return registry;
  }

  probe(): Promise<void> {
    return Promise.all([...this.registries.values()].map((registry) => registry.probe())).then(
      () => undefined,
    );
  }

  probeExecution(): Promise<void> {
    return this.require(this.defaultProviderKey).probeExecution();
  }

  acquire(
    input: Parameters<SandboxSessionRegistryPort["acquire"]>[0],
  ): Promise<SandboxAcquireResult> {
    return this.require(this.defaultProviderKey).acquire(input);
  }

  create(input: Parameters<ThreadSandboxProviderPort["create"]>[0]): Promise<SandboxAcquireResult> {
    return this.require(this.defaultProviderKey).create(input);
  }

  connect(
    input: Parameters<ThreadSandboxProviderPort["connect"]>[0],
  ): Promise<SandboxAcquireResult | { readonly outcome: "not_found" }> {
    return this.require(input.providerKey).connect(input);
  }

  settle(
    input: Parameters<SandboxSessionRegistryPort["settle"]>[0],
  ): Promise<SandboxSettlementResult> {
    return this.require(input.session.providerKey).settle(input);
  }

  closeOrphan(
    input: Parameters<OrphanSandboxCleanupPort["closeOrphan"]>[0],
  ): Promise<SandboxSettlementResult> {
    return this.require(input.session.providerKey).closeOrphan(input);
  }

  workspaceCapability(input: {
    readonly scope: ExecutionScope;
    readonly session: SandboxSessionRef;
  }): TrustedSandboxSessionCapability {
    const registry = this.require(input.session.providerKey);
    const capability = registry.workspaceCapability(input);
    this.workspaceOwners.set(capability, registry);
    return capability;
  }

  connectWorkspace(
    capability: TrustedSandboxSessionCapability,
    options: SandboxWorkspaceAdapterOptions,
    control?: OperationControl,
  ): Promise<SandboxWorkspacePort> {
    const registry = this.workspaceOwners.get(capability);
    if (registry === undefined) throw new Error("未授予 Sandbox Workspace capability");
    return registry.gateway.connectWorkspace(capability, options, control);
  }
}

interface WorkspaceCapabilityBinding {
  readonly registryId: string;
  readonly providerKey: SandboxSessionRef["providerKey"];
  readonly providerSandboxId: string;
  readonly scope: ExecutionScope;
}

function freezeExecutionScope(scope: ExecutionScope): ExecutionScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    rootRunId: scope.rootRunId,
    workspaceId: scope.workspaceId,
    ...(scope.baseRevisionId === undefined ? {} : { baseRevisionId: scope.baseRevisionId }),
  });
}

function sameExecutionScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

function fallbackUncertainEvent(
  providerKey: UncertainLifecycleEvent["providerKey"],
  requestId: string,
  actualTtlSeconds: number,
  sandboxId?: string,
): UncertainLifecycleEvent {
  return {
    providerKey,
    kind: "sandbox_create_outcome_unknown",
    stage: sandboxId === undefined ? "create_response" : "cleanup_after_create",
    requestId,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    actualTtlSeconds,
    occurredAt: new Date().toISOString(),
  };
}

/** 未启用 Artifact Router 时不存在 required declaration，完成门确定通过。 */
export class NoDeclaredArtifactCompletionGate implements ArtifactPublicationPort {
  async assertReadyForCompletion(): Promise<void> {}
}

interface DispatchQueue {
  claim(input: {
    readonly tenantId: string;
    readonly dispatcherId: string;
    readonly limit: number;
    readonly leaseMilliseconds: number;
  }): ReturnType<PgRunDispatchOutbox["claim"]>;
  acknowledge(input: {
    readonly claim: PgClaimedRunDispatch;
    readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
    readonly retryAfterMilliseconds?: number;
  }): Promise<void>;
}

interface TenantAssignmentQueue {
  claim(input: {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
  }): ReturnType<PgWorkerTenantAssignments["claim"]>;
  settle(assignment: PgClaimedWorkerTenantAssignment): Promise<boolean>;
}

/** 动态 Tenant 消费闭环：先领控制面租约，再在对应 Tenant RLS 内领取 durable dispatch。 */
export class AgentWorkerPollingLoop {
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly tenantAssignments: TenantAssignmentQueue,
    private readonly queue: DispatchQueue,
    private readonly worker: Pick<RunWorker, "execute">,
    private readonly options: {
      readonly workerId: string;
      readonly pollIntervalMs: number;
      readonly tenantAssignmentLeaseMs: number;
      readonly dispatchLeaseMs: number;
      /** 周期性收敛已具 durable anchor 的维护任务；失败不阻塞 dispatch，下一 tick 重试。 */
      readonly maintenance?: (tenantId: string) => Promise<unknown>;
    },
  ) {}

  start(): void {
    if (this.closed || this.timer !== undefined)
      throw new Error("Agent Worker polling loop 状态无效");
    this.schedule(0);
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.inFlight;
  }

  stopAccepting(): void {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  drain(): Promise<void> {
    return this.inFlight;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.tick().finally(() => this.schedule(this.options.pollIntervalMs));
    }, delay);
  }

  private async tick(): Promise<void> {
    let assignment: PgClaimedWorkerTenantAssignment | undefined;
    try {
      assignment = await this.tenantAssignments.claim({
        workerId: this.options.workerId,
        leaseMilliseconds: this.options.tenantAssignmentLeaseMs,
      });
    } catch {
      return;
    }
    if (assignment === undefined) return;
    let claims: readonly PgClaimedRunDispatch[] = [];
    try {
      if (this.closed) {
        return;
      }
      try {
        await this.options.maintenance?.(assignment.tenantId);
      } catch {
        // 维护任务必须保持幂等 durable anchor；失败不阻塞当前 Tenant 的 dispatch。
      }
      try {
        claims = await this.queue.claim({
          tenantId: assignment.tenantId,
          dispatcherId: this.options.workerId,
          limit: 1,
          leaseMilliseconds: this.options.dispatchLeaseMs,
        });
      } catch {
        return;
      }
    } finally {
      try {
        // Tenant 租约只负责发现和公平分配，不能包住模型执行而串行化不同 Thread。
        await this.tenantAssignments.settle(assignment);
      } catch {
        // 控制面租约会过期；迟到 settle 受 generation/token 栅栏保护。
      }
    }
    for (const claim of claims) {
      if (this.closed) {
        try {
          await this.queue.acknowledge({
            claim,
            outcome: "defer",
            // 与 PgRunDispatchOutbox 的最小重试约束一致，确保 ack 真正释放 dispatch claim。
            retryAfterMilliseconds: 1_000,
          });
        } catch {
          // claim lease 会过期；关闭后的 claim 绝不交给 RunWorker 执行。
        }
        continue;
      }
      const result = await this.executeSafely(claim.scope);
      try {
        await this.queue.acknowledge({ claim, ...acknowledgement(result) });
      } catch {
        // claim lease 会过期并由后续 tick 重领；RunWorker 的 Attempt claim 保证执行幂等。
      }
    }
  }

  private async executeSafely(scope: PgClaimedRunDispatch["scope"]): Promise<RunWorkerResult> {
    try {
      return await this.worker.execute(scope as ExecutionScope);
    } catch {
      return { outcome: "retryable", code: "PERSISTENCE_UNAVAILABLE" };
    }
  }
}

function acknowledgement(result: RunWorkerResult): {
  readonly outcome: "dispatched" | "terminal" | "waiting" | "defer";
  readonly retryAfterMilliseconds?: number;
} {
  if (
    result.outcome === "succeeded" ||
    result.outcome === "failed" ||
    result.outcome === "cancelled"
  ) {
    return { outcome: "terminal" };
  }
  if (result.outcome === "waiting") return { outcome: "waiting" };
  if (result.outcome === "ignored") {
    if (result.reason === "terminal") return { outcome: "terminal" };
    if (result.reason === "waiting_for_answer") return { outcome: "waiting" };
    return { outcome: "defer", retryAfterMilliseconds: 5_000 };
  }
  if (result.outcome === "recovery_required") return { outcome: "dispatched" };
  return { outcome: "defer", retryAfterMilliseconds: 5_000 };
}
