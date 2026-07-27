import {
  artifactId,
  isoTimestamp,
  resourceVersionId,
  runId,
  sha256Digest,
  tenantId,
  threadId,
  userId,
  workspaceId,
  workspaceRevisionId,
} from "@cube-runtime/domain";
import type { BlobStore, StableBlobRef } from "@cube-runtime/persistence";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactExecutionAuthorization, type MonotonicClockPort } from "./authorization.js";
import type {
  ArtifactBlobBinding,
  ArtifactDeliveryRepositoryPort,
  ArtifactPublicationSnapshot,
  AuthorizedArtifactDownload,
  BeginArtifactPublicationResult,
  CompletionInspectionResult,
  DeclareDeliverablesResult,
  FinishArtifactPublicationResult,
  ReadArtifactPublicationResult,
  UserRequestScope,
} from "./contracts.js";
import { ArtifactDeliveryError } from "./errors.js";
import { ArtifactDeliveryService, type PublishArtifactCommand } from "./service.js";

const scope: ExecutionScope = Object.freeze({
  tenantId: tenantId("tenant_alpha"),
  threadId: threadId("thread_alpha"),
  runId: runId("run_alpha"),
  rootRunId: runId("run_alpha"),
  workspaceId: workspaceId("workspace_alpha"),
});
const request: UserRequestScope = Object.freeze({
  tenantId: scope.tenantId,
  userId: userId("user_alpha"),
});
const artifactOne = artifactId("artifact_one");
const versionOne = resourceVersionId("resource_version_one");
const placeholderDigest = sha256Digest("0".repeat(64));
const immediateMonotonicClock: MonotonicClockPort = Object.freeze({ now: () => 100 });

class MutableMonotonicClock implements MonotonicClockPort {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

function executionAuthorization(input: {
  readonly toolName: "declare_deliverables" | "publish_artifact";
  readonly args: unknown;
  readonly executionScope?: ExecutionScope;
  readonly permitId?: string;
  readonly expiresAt?: string;
  readonly clock?: MonotonicClockPort;
  readonly consumedAtMonotonicMs?: number;
  readonly maxContinuationDelayMs?: number;
  readonly overrides?: Partial<{
    effect: "model_start" | "tool_execution";
    runClaimToken: string;
    runClaimEpoch: number;
    workspaceRootRunId: typeof scope.rootRunId;
    workspaceLeaseEpoch: number;
    attemptVersion: number;
    callId: string;
    toolName: string;
    argsDigest: ReturnType<typeof digestCanonical>;
  }>;
}): ArtifactExecutionAuthorization {
  const executionScope = input.executionScope ?? scope;
  return ArtifactExecutionAuthorization.fromConsumed(
    {
      permit: {
        permitId: input.permitId ?? "permit-artifact-1",
        scope: executionScope,
        runClaimToken: "run-claim-token-1",
        runClaimEpoch: 7,
        workspaceRootRunId: executionScope.rootRunId,
        workspaceLeaseEpoch: 11,
        attemptVersion: 13,
        effect: "tool_execution",
        callId: "call-artifact-1",
        toolName: input.toolName,
        argsDigest: digestCanonical(input.args),
        issuedAt: isoTimestamp("2026-07-26T08:00:00.000Z"),
        expiresAt: isoTimestamp(input.expiresAt ?? "2026-07-26T08:01:00.000Z"),
        ...input.overrides,
      },
      consumedAt: isoTimestamp("2026-07-26T08:00:01.000Z"),
      consumedAtMonotonicMs: input.consumedAtMonotonicMs ?? 100,
      maxContinuationDelayMs: input.maxContinuationDelayMs ?? 1_000,
    },
    input.clock ?? immediateMonotonicClock,
  );
}

function stableBlob(overrides: Partial<StableBlobRef> = {}): StableBlobRef {
  return {
    kind: "stable",
    tenantId: scope.tenantId,
    purpose: "resource",
    sha256: "a".repeat(64),
    size: 12,
    mediaType: "text/plain",
    incarnationId: "11111111-1111-4111-8111-111111111111",
    physicalObjectKey: `objects/stable/${scope.tenantId}/resource/sha256/${"a".repeat(64)}/incarnations/11111111-1111-4111-8111-111111111111`,
    ...overrides,
  };
}

function publication(
  overrides: Partial<ArtifactPublicationSnapshot> = {},
): ArtifactPublicationSnapshot {
  return {
    artifactId: artifactOne,
    tenantId: scope.tenantId,
    threadId: scope.threadId,
    runId: scope.runId,
    resourceVersionId: versionOne,
    name: "最终报告.txt",
    purpose: "deliverable",
    deliverableKey: "report",
    status: "publishing",
    ...overrides,
  };
}

function processPublication(
  purpose: "diagnostic" | "trace",
  id: ArtifactPublicationSnapshot["artifactId"],
): ArtifactPublicationSnapshot {
  const { deliverableKey: _deliverableKey, ...base } = publication();
  return { ...base, artifactId: id, purpose, status: "published" };
}

function binding(overrides: Partial<ArtifactBlobBinding> = {}): ArtifactBlobBinding {
  return {
    resourceVersionId: versionOne,
    mediaType: "text/plain",
    blob: stableBlob(),
    ...overrides,
  };
}

function publishCommand(overrides: Partial<PublishArtifactCommand> = {}): PublishArtifactCommand {
  const { authorization: overrideAuthorization, ...businessOverrides } = overrides;
  const business: Omit<PublishArtifactCommand, "authorization"> = {
    toolArgsDigest: placeholderDigest,
    idempotencyKey: "publish:run_alpha:report:1",
    artifactId: artifactOne,
    resourceVersionId: versionOne,
    name: "最终报告.txt",
    purpose: "deliverable",
    deliverableKey: "report",
    ...businessOverrides,
  };
  const authorization =
    overrideAuthorization ??
    executionAuthorization({
      toolName: "publish_artifact",
      args: business.toolArgsDigest,
      overrides: { argsDigest: business.toolArgsDigest },
    });
  return { ...business, authorization };
}

function declarationInput(input: {
  readonly idempotencyKey: string;
  readonly declarations: readonly {
    readonly key: string;
    readonly name: string;
    readonly requirement: "required" | "optional";
  }[];
  readonly executionScope?: ExecutionScope;
}): Parameters<ArtifactDeliveryService["declareDeliverables"]>[0] {
  return {
    idempotencyKey: input.idempotencyKey,
    declarations: input.declarations,
    authorization: executionAuthorization({
      toolName: "declare_deliverables",
      args: {
        idempotencyKey: input.idempotencyKey,
        declarations: input.declarations,
      },
      ...(input.executionScope === undefined ? {} : { executionScope: input.executionScope }),
    }),
  };
}

class FakeRepository implements ArtifactDeliveryRepositoryPort {
  declarationResult: DeclareDeliverablesResult = {
    outcome: "applied",
    commandDigest: placeholderDigest,
  };
  declarationReadback: DeclareDeliverablesResult | { readonly outcome: "not_found" } = {
    outcome: "not_found",
  };
  beginResult: BeginArtifactPublicationResult = {
    outcome: "started",
    publication: publication(),
    binding: binding(),
  };
  finishResult: FinishArtifactPublicationResult = {
    outcome: "applied",
    publication: publication({ status: "published" }),
  };
  readResult: ReadArtifactPublicationResult = { outcome: "not_found" };
  completionResult: CompletionInspectionResult = { outcome: "ready" };
  listed: readonly ArtifactPublicationSnapshot[] = [];
  listOutcome: "authorized" | "not_found" | "unavailable" = "authorized";
  downloadOutcome: "authorized" | "not_found" | "unavailable" = "authorized";
  download: AuthorizedArtifactDownload = {
    authorization: { scope: request, authorizationRevision: "auth-revision-1" },
    publication: publication({ status: "published" }),
    binding: binding(),
  };
  confirmOutcome: "confirmed" | "not_found" | "changed" | "unavailable" = "confirmed";
  beginInputs: Parameters<ArtifactDeliveryRepositoryPort["beginPublication"]>[0][] = [];
  finishInputs: Parameters<ArtifactDeliveryRepositoryPort["finishPublication"]>[0][] = [];
  declareInputs: Parameters<ArtifactDeliveryRepositoryPort["declareDeliverables"]>[0][] = [];
  declarationReadInputs: Parameters<
    ArtifactDeliveryRepositoryPort["readDeliverableDeclarationCommand"]
  >[0][] = [];

  async declareDeliverables(
    input: Parameters<ArtifactDeliveryRepositoryPort["declareDeliverables"]>[0],
  ): Promise<DeclareDeliverablesResult> {
    this.declareInputs.push(input);
    if (
      this.declarationResult.outcome === "applied" ||
      this.declarationResult.outcome === "already_applied"
    ) {
      return { ...this.declarationResult, commandDigest: input.commandDigest };
    }
    return this.declarationResult;
  }

  async readDeliverableDeclarationCommand(
    input: Parameters<ArtifactDeliveryRepositoryPort["readDeliverableDeclarationCommand"]>[0],
  ): Promise<DeclareDeliverablesResult | { readonly outcome: "not_found" }> {
    this.declarationReadInputs.push(input);
    if (
      this.declarationReadback.outcome === "applied" ||
      this.declarationReadback.outcome === "already_applied"
    ) {
      const last = this.declareInputs.at(-1);
      return {
        ...this.declarationReadback,
        commandDigest:
          this.declarationReadback.commandDigest === placeholderDigest
            ? (last?.commandDigest ?? placeholderDigest)
            : this.declarationReadback.commandDigest,
      };
    }
    return this.declarationReadback;
  }

  async beginPublication(
    input: Parameters<ArtifactDeliveryRepositoryPort["beginPublication"]>[0],
  ): Promise<BeginArtifactPublicationResult> {
    this.beginInputs.push(input);
    return this.beginResult;
  }

  async finishPublication(
    input: Parameters<ArtifactDeliveryRepositoryPort["finishPublication"]>[0],
  ): Promise<FinishArtifactPublicationResult> {
    this.finishInputs.push(input);
    return this.finishResult;
  }

  async readPublicationCommand(
    _input: Parameters<ArtifactDeliveryRepositoryPort["readPublicationCommand"]>[0],
  ): Promise<ReadArtifactPublicationResult> {
    return this.readResult;
  }

  async inspectCompletion(): Promise<CompletionInspectionResult> {
    return this.completionResult;
  }

  async listAuthorizedArtifacts(): Promise<
    | { readonly outcome: "authorized"; readonly artifacts: readonly ArtifactPublicationSnapshot[] }
    | { readonly outcome: "not_found" | "unavailable" }
  > {
    return this.listOutcome === "authorized"
      ? { outcome: "authorized", artifacts: this.listed }
      : { outcome: this.listOutcome };
  }

  async authorizeDownload(): Promise<
    | { readonly outcome: "authorized"; readonly download: AuthorizedArtifactDownload }
    | { readonly outcome: "not_found" | "unavailable" }
  > {
    return this.downloadOutcome === "authorized"
      ? { outcome: "authorized", download: this.download }
      : { outcome: this.downloadOutcome };
  }

  async confirmDownloadAuthorization(): Promise<
    | { readonly outcome: "confirmed" }
    | { readonly outcome: "not_found" | "changed" | "unavailable" }
  > {
    return { outcome: this.confirmOutcome };
  }
}

function fakeBlobStore(): BlobStore {
  const blob = stableBlob();
  return {
    putStaging: vi.fn(),
    promote: vi.fn(),
    head: vi.fn(async () => ({ blob })),
    read: vi.fn(),
    getBytes: vi.fn(),
    deleteStaging: vi.fn(),
    presignDownload: vi.fn(async () => "https://downloads.example.test/signed?token=redacted"),
  };
}

function expectCode(error: unknown, code: ArtifactDeliveryError["code"]): boolean {
  expect(error).toBeInstanceOf(ArtifactDeliveryError);
  expect((error as ArtifactDeliveryError).code).toBe(code);
  return true;
}

describe("ArtifactDeliveryService 发布与完成门", () => {
  let repository: FakeRepository;
  let blobs: BlobStore;
  let service: ArtifactDeliveryService;

  beforeEach(() => {
    repository = new FakeRepository();
    blobs = fakeBlobStore();
    service = new ArtifactDeliveryService(repository, blobs, {
      monotonicClock: immediateMonotonicClock,
    });
  });

  it("固定 running Run、ResourceVersion 与 Blob 身份后发布，并允许同摘要幂等读回", async () => {
    await expect(service.publishArtifact(publishCommand())).resolves.toMatchObject({
      artifactId: artifactOne,
      status: "published",
    });
    expect(repository.beginInputs[0]).toMatchObject({
      authorization: expect.objectContaining({ scope }),
      artifactId: artifactOne,
      resourceVersionId: versionOne,
      purpose: "deliverable",
      deliverableKey: "report",
    });
    expect(repository.finishInputs).toHaveLength(1);
    expect(repository.finishInputs[0]?.target).toBe("published");

    repository.beginResult = {
      outcome: "already_finished",
      publication: publication({ status: "published" }),
      binding: binding(),
    };
    await expect(service.publishArtifact(publishCommand())).resolves.toMatchObject({
      status: "published",
    });
    expect(repository.finishInputs).toHaveLength(1);
  });

  it("普通同形请求对象不能伪造 Artifact 写授权，Repository 收到可重验的窄授权", async () => {
    const command = publishCommand();
    const forged = { ...command.authorization } as ArtifactExecutionAuthorization;
    await expect(service.publishArtifact({ ...command, authorization: forged })).rejects.toSatisfy(
      (error) => expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
    );
    expect(repository.beginInputs).toHaveLength(0);

    await service.publishArtifact(command);
    expect(repository.beginInputs[0]?.authorization).toBe(command.authorization);
    expect(repository.finishInputs[0]?.authorization).toBe(command.authorization);
    expect(repository.beginInputs[0]?.authorization).toMatchObject({
      permitId: "permit-artifact-1",
      scope,
      runClaimToken: "run-claim-token-1",
      runClaimEpoch: 7,
      workspaceRootRunId: scope.rootRunId,
      workspaceLeaseEpoch: 11,
      attemptVersion: 13,
      effect: "tool_execution",
      callId: "call-artifact-1",
      toolName: "publish_artifact",
    });
  });

  it("授权逐字段拒绝错误 effect、双栅栏、Attempt、toolName 与 argsDigest", async () => {
    const business = publishCommand();
    const rawArgs = {
      idempotencyKey: business.idempotencyKey,
      artifactId: business.artifactId,
      resourceVersionId: business.resourceVersionId,
      replacesArtifactId: business.replacesArtifactId,
      name: business.name,
      purpose: business.purpose,
      deliverableKey: business.deliverableKey,
    };
    const invalidAtMint = [
      { effect: "model_start" as const },
      { runClaimToken: "" },
      { runClaimEpoch: -1 },
      { workspaceRootRunId: runId("run_wrong_root") },
      { workspaceLeaseEpoch: -1 },
      { attemptVersion: -1 },
      { callId: "" },
    ];
    for (const overrides of invalidAtMint) {
      expect(() =>
        executionAuthorization({
          toolName: "publish_artifact",
          args: rawArgs,
          overrides,
        }),
      ).toThrowError(expect.objectContaining({ code: "ARTIFACT_NOT_AUTHORIZED" }));
    }

    for (const authorization of [
      executionAuthorization({
        toolName: "publish_artifact",
        args: rawArgs,
        overrides: {
          toolName: "declare_deliverables",
          argsDigest: business.toolArgsDigest,
        },
      }),
      executionAuthorization({
        toolName: "publish_artifact",
        args: rawArgs,
        overrides: { argsDigest: digestCanonical({ changed: true }) },
      }),
    ]) {
      await expect(service.publishArtifact({ ...business, authorization })).rejects.toSatisfy(
        (error) => expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
      );
    }
    expect(repository.beginInputs).toHaveLength(0);
  });

  it("Consumed permit 收窄使用单调时钟，刚消费和窗口内通过，边界、超时及负 elapsed 拒绝", () => {
    const business = publishCommand();
    const args = {
      idempotencyKey: business.idempotencyKey,
      artifactId: business.artifactId,
      resourceVersionId: business.resourceVersionId,
      replacesArtifactId: business.replacesArtifactId,
      name: business.name,
      purpose: business.purpose,
      deliverableKey: business.deliverableKey,
    };
    for (const now of [100, 101, 1_099]) {
      expect(
        executionAuthorization({
          toolName: "publish_artifact",
          args,
          clock: { now: () => now },
        }),
      ).toBeInstanceOf(ArtifactExecutionAuthorization);
    }
    for (const now of [99, 1_100, 1_101]) {
      expect(() =>
        executionAuthorization({
          toolName: "publish_artifact",
          args,
          clock: { now: () => now },
        }),
      ).toThrowError(expect.objectContaining({ code: "ARTIFACT_NOT_AUTHORIZED" }));
    }
  });

  it("授权创建后闲置不能绕过，declare 与 publish 每次入口重新检查单调窗口", async () => {
    const clock = new MutableMonotonicClock(100);
    const commandAtConsumption = publishCommand();
    const command = publishCommand({
      authorization: executionAuthorization({
        toolName: "publish_artifact",
        args: {
          idempotencyKey: commandAtConsumption.idempotencyKey,
          artifactId: commandAtConsumption.artifactId,
          resourceVersionId: commandAtConsumption.resourceVersionId,
          replacesArtifactId: commandAtConsumption.replacesArtifactId,
          name: commandAtConsumption.name,
          purpose: commandAtConsumption.purpose,
          deliverableKey: commandAtConsumption.deliverableKey,
        },
        clock,
        overrides: { argsDigest: commandAtConsumption.toolArgsDigest },
      }),
    });
    const declarations = [{ key: "report", name: "报告", requirement: "required" as const }];
    const declaration = {
      idempotencyKey: "declare:run_alpha:idle",
      declarations,
      authorization: executionAuthorization({
        toolName: "declare_deliverables",
        args: { idempotencyKey: "declare:run_alpha:idle", declarations },
        clock,
      }),
    };
    const clockedService = new ArtifactDeliveryService(repository, blobs, {
      monotonicClock: clock,
    });
    clock.value = 1_100;
    await expect(clockedService.publishArtifact(command)).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
    );
    await expect(clockedService.declareDeliverables(declaration)).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
    );
    expect(repository.beginInputs).toHaveLength(0);
    expect(repository.declareInputs).toHaveLength(0);
  });

  it("begin 后远端检查耗尽窗口时不允许 finish，响应未知后过期也不允许 readback", async () => {
    const clock = new MutableMonotonicClock(100);
    const base = publishCommand();
    const args = {
      idempotencyKey: base.idempotencyKey,
      artifactId: base.artifactId,
      resourceVersionId: base.resourceVersionId,
      replacesArtifactId: base.replacesArtifactId,
      name: base.name,
      purpose: base.purpose,
      deliverableKey: base.deliverableKey,
    };
    const clockedService = new ArtifactDeliveryService(repository, blobs, {
      monotonicClock: clock,
    });
    const command = {
      ...base,
      authorization: executionAuthorization({
        toolName: "publish_artifact",
        args,
        clock,
        overrides: { argsDigest: base.toolArgsDigest },
      }),
    };
    vi.mocked(blobs.head).mockImplementationOnce(async () => {
      clock.value = 1_100;
      return { blob: stableBlob() };
    });
    await expect(clockedService.publishArtifact(command)).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
    );
    expect(repository.beginInputs).toHaveLength(1);
    expect(repository.finishInputs).toHaveLength(0);

    clock.value = 100;
    const second = publishCommand({
      idempotencyKey: "publish:run_alpha:response-unknown",
    });
    const secondArgs = {
      idempotencyKey: second.idempotencyKey,
      artifactId: second.artifactId,
      resourceVersionId: second.resourceVersionId,
      replacesArtifactId: second.replacesArtifactId,
      name: second.name,
      purpose: second.purpose,
      deliverableKey: second.deliverableKey,
    };
    vi.mocked(blobs.head).mockResolvedValueOnce({ blob: stableBlob() });
    repository.finishPublication = async (input) => {
      repository.finishInputs.push(input);
      clock.value = 1_100;
      return { outcome: "response_unknown" };
    };
    let readCalled = false;
    repository.readPublicationCommand = async () => {
      readCalled = true;
      return { outcome: "not_found" };
    };
    await expect(
      clockedService.publishArtifact({
        ...second,
        authorization: executionAuthorization({
          toolName: "publish_artifact",
          args: secondArgs,
          clock,
          overrides: { argsDigest: second.toolArgsDigest },
        }),
      }),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_NOT_AUTHORIZED"));
    expect(readCalled).toBe(false);
  });

  it("declare 响应未知后窗口耗尽时不允许 readback", async () => {
    const clock = new MutableMonotonicClock(100);
    const declarations = [{ key: "report", name: "报告", requirement: "required" as const }];
    const input = {
      idempotencyKey: "declare:run_alpha:response-unknown",
      declarations,
      authorization: executionAuthorization({
        toolName: "declare_deliverables",
        args: { idempotencyKey: "declare:run_alpha:response-unknown", declarations },
        clock,
      }),
    };
    repository.declareDeliverables = async (command) => {
      repository.declareInputs.push(command);
      clock.value = 1_100;
      return { outcome: "response_unknown" };
    };
    let readCalled = false;
    repository.readDeliverableDeclarationCommand = async () => {
      readCalled = true;
      return { outcome: "not_found" };
    };
    const clockedService = new ArtifactDeliveryService(repository, blobs, {
      monotonicClock: clock,
    });
    await expect(clockedService.declareDeliverables(input)).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_NOT_AUTHORIZED"),
    );
    expect(readCalled).toBe(false);
  });

  it("canonical command digest 绑定 kind、完整稳定 scope、幂等键与每个规范化业务字段", async () => {
    repository.beginResult = { outcome: "conflict" };
    const capturePublishDigest = async (
      overrides: Partial<PublishArtifactCommand> = {},
      executionScope: ExecutionScope = scope,
    ) => {
      const raw = publishCommand({ ...overrides });
      const authorization = executionAuthorization({
        toolName: "publish_artifact",
        args: raw.toolArgsDigest,
        overrides: { argsDigest: raw.toolArgsDigest },
        executionScope,
      });
      await service.publishArtifact({ ...raw, authorization }).catch(() => undefined);
      const digest = repository.beginInputs.at(-1)?.commandDigest;
      expect(digest).toBeDefined();
      return digest;
    };
    const baseDigest = await capturePublishDigest();
    const scopeCases: readonly ExecutionScope[] = [
      { ...scope, tenantId: tenantId("tenant_beta") },
      { ...scope, threadId: threadId("thread_beta") },
      { ...scope, runId: runId("run_beta") },
      { ...scope, rootRunId: runId("root_run_beta") },
      { ...scope, workspaceId: workspaceId("workspace_beta") },
      { ...scope, baseRevisionId: workspaceRevisionId("revision_beta") },
    ];
    for (const changedScope of scopeCases) {
      expect(await capturePublishDigest({}, changedScope)).not.toBe(baseDigest);
    }

    const businessCases: readonly Partial<PublishArtifactCommand>[] = [
      { toolArgsDigest: sha256Digest("9".repeat(64)) },
      { idempotencyKey: "publish:run_alpha:report:other" },
      { artifactId: artifactId("artifact_other") },
      { resourceVersionId: resourceVersionId("resource_version_other") },
      { replacesArtifactId: artifactId("artifact_failed_parent") },
      { name: "其他报告.txt" },
      { deliverableKey: "other-report" },
    ];
    for (const changedBusiness of businessCases) {
      expect(await capturePublishDigest(changedBusiness)).not.toBe(baseDigest);
    }
    const deliverable = publishCommand();
    const {
      authorization: _authorization,
      deliverableKey: _deliverableKey,
      ...processBusiness
    } = deliverable;
    const processCommand = { ...processBusiness, purpose: "diagnostic" as const };
    const processAuthorization = executionAuthorization({
      toolName: "publish_artifact",
      args: processCommand.toolArgsDigest,
      overrides: { argsDigest: processCommand.toolArgsDigest },
    });
    await service
      .publishArtifact({ ...processCommand, authorization: processAuthorization })
      .catch(() => undefined);
    expect(repository.beginInputs.at(-1)?.commandDigest).not.toBe(baseDigest);

    const normalizedDigest = await capturePublishDigest({ name: "  最终报告.txt  " });
    expect(normalizedDigest).toBe(baseDigest);

    repository.declarationResult = { outcome: "conflict" };
    const captureDeclarationDigest = async (
      idempotencyKey: string,
      declarations: readonly {
        readonly key: string;
        readonly name: string;
        readonly requirement: "required" | "optional";
      }[],
      executionScope: ExecutionScope = scope,
    ) => {
      await service
        .declareDeliverables(declarationInput({ idempotencyKey, declarations, executionScope }))
        .catch(() => undefined);
      const digest = repository.declareInputs.at(-1)?.commandDigest;
      expect(digest).toBeDefined();
      return digest;
    };
    const baseDeclarationDigest = await captureDeclarationDigest("declare:run_alpha:1", [
      { key: "report", name: "最终报告.txt", requirement: "required" },
    ]);
    expect(baseDeclarationDigest).not.toBe(baseDigest);
    for (const changedScope of scopeCases) {
      expect(
        await captureDeclarationDigest(
          "declare:run_alpha:1",
          [{ key: "report", name: "最终报告.txt", requirement: "required" }],
          changedScope,
        ),
      ).not.toBe(baseDeclarationDigest);
    }
    const declarationCases = [
      {
        idempotencyKey: "declare:run_alpha:other",
        declarations: [{ key: "report", name: "最终报告.txt", requirement: "required" as const }],
      },
      {
        idempotencyKey: "declare:run_alpha:1",
        declarations: [{ key: "other", name: "最终报告.txt", requirement: "required" as const }],
      },
      {
        idempotencyKey: "declare:run_alpha:1",
        declarations: [{ key: "report", name: "其他报告.txt", requirement: "required" as const }],
      },
      {
        idempotencyKey: "declare:run_alpha:1",
        declarations: [{ key: "report", name: "最终报告.txt", requirement: "optional" as const }],
      },
      {
        idempotencyKey: "declare:run_alpha:1",
        declarations: [
          { key: "report", name: "最终报告.txt", requirement: "required" as const },
          { key: "appendix", name: "附录.txt", requirement: "optional" as const },
        ],
      },
    ];
    for (const changed of declarationCases) {
      expect(await captureDeclarationDigest(changed.idempotencyKey, changed.declarations)).not.toBe(
        baseDeclarationDigest,
      );
    }
    expect(
      await captureDeclarationDigest("declare:run_alpha:1", [
        { key: "  report  ", name: "  最终报告.txt  ", requirement: "required" },
      ]),
    ).toBe(baseDeclarationDigest);
  });

  it("permitId 与 expiresAt 不进入幂等摘要，授权仍作为独立事实下传", async () => {
    repository.beginResult = { outcome: "conflict" };
    const base = publishCommand();
    const args = {
      toolArgsDigest: base.toolArgsDigest,
    };
    for (const authorization of [
      executionAuthorization({
        toolName: "publish_artifact",
        args,
        permitId: "permit-a",
        overrides: { argsDigest: base.toolArgsDigest },
      }),
      executionAuthorization({
        toolName: "publish_artifact",
        args,
        permitId: "permit-b",
        expiresAt: "2026-07-26T08:02:00.000Z",
        overrides: { argsDigest: base.toolArgsDigest },
      }),
    ]) {
      await service.publishArtifact({ ...base, authorization }).catch(() => undefined);
    }
    expect(repository.beginInputs.at(-2)?.commandDigest).toBe(
      repository.beginInputs.at(-1)?.commandDigest,
    );
    expect(repository.beginInputs.at(-2)?.authorization.permitId).not.toBe(
      repository.beginInputs.at(-1)?.authorization.permitId,
    );
  });

  it("发布响应丢失时只按相同命令摘要 readback，不重复制造 Artifact", async () => {
    repository.finishResult = { outcome: "response_unknown" };
    repository.readResult = {
      outcome: "found",
      commandDigest: placeholderDigest,
      publication: publication({ status: "published" }),
      binding: binding(),
    };
    repository.readPublicationCommand = async (
      input: Parameters<ArtifactDeliveryRepositoryPort["readPublicationCommand"]>[0],
    ) => {
      expect(input.authorization).toBe(repository.finishInputs[0]?.authorization);
      return {
        ...(repository.readResult as Extract<ReadArtifactPublicationResult, { outcome: "found" }>),
        commandDigest:
          repository.finishInputs.find(
            (candidate) => candidate.idempotencyKey === input.idempotencyKey,
          )?.commandDigest ?? placeholderDigest,
      };
    };

    await expect(service.publishArtifact(publishCommand())).resolves.toMatchObject({
      status: "published",
    });
    expect(repository.beginInputs).toHaveLength(1);
    expect(repository.finishInputs).toHaveLength(1);
  });

  it("发布响应丢失 readback 的 ResourceVersion 或 Blob 身份漂移时拒绝接受", async () => {
    repository.finishResult = { outcome: "response_unknown" };
    repository.readPublicationCommand = async (input) => ({
      outcome: "found",
      commandDigest:
        repository.finishInputs.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey,
        )?.commandDigest ?? placeholderDigest,
      publication: publication({ status: "published" }),
      binding: binding({
        blob: stableBlob({ incarnationId: "22222222-2222-4222-8222-222222222222" }),
      }),
    });
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_IDEMPOTENCY_CONFLICT"),
    );
  });

  it("相同幂等键的摘要或不可变绑定冲突稳定拒绝", async () => {
    repository.beginResult = { outcome: "conflict" };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_IDEMPOTENCY_CONFLICT"),
    );

    repository.beginResult = {
      outcome: "already_started",
      publication: publication({ resourceVersionId: resourceVersionId("resource_version_other") }),
      binding: binding(),
    };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_IDEMPOTENCY_CONFLICT"),
    );
  });

  it("Blob 缺失或依赖抛错都会把本次发布终结为 failed，不能原记录重试", async () => {
    vi.mocked(blobs.head)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("private object key and provider response"));
    repository.finishResult = {
      outcome: "applied",
      publication: publication({ status: "failed" }),
    };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_PUBLICATION_FAILED"),
    );
    expect(repository.finishInputs.at(-1)?.target).toBe("failed");

    const secondArtifactId = artifactId("artifact_blob_error");
    const secondVersionId = resourceVersionId("resource_version_blob_error");
    repository.beginResult = {
      outcome: "started",
      publication: publication({
        artifactId: secondArtifactId,
        resourceVersionId: secondVersionId,
      }),
      binding: binding({ resourceVersionId: secondVersionId }),
    };
    repository.finishResult = {
      outcome: "applied",
      publication: publication({
        artifactId: secondArtifactId,
        resourceVersionId: secondVersionId,
        status: "failed",
      }),
    };
    await expect(
      service.publishArtifact(
        publishCommand({
          artifactId: secondArtifactId,
          resourceVersionId: secondVersionId,
          idempotencyKey: "publish:run_alpha:blob-error:1",
        }),
      ),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_PUBLICATION_FAILED"));
    expect(repository.finishInputs.at(-1)?.target).toBe("failed");

    repository.beginResult = {
      outcome: "already_finished",
      publication: publication({ status: "failed" }),
      binding: binding(),
    };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_PUBLICATION_FAILED"),
    );
    expect(blobs.head).toHaveBeenCalledTimes(2);
  });

  it("跨 Tenant、Thread、Run 或 Resource 错配不向调用者泄漏存在性", async () => {
    repository.beginResult = { outcome: "scope_mismatch" };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_NOT_FOUND"),
    );
    repository.beginResult = { outcome: "resource_mismatch" };
    await expect(service.publishArtifact(publishCommand())).rejects.toSatisfy((error) =>
      expectCode(error, "ARTIFACT_IDEMPOTENCY_CONFLICT"),
    );
  });

  it("修正必须是新 ResourceVersion、新 Artifact 并显式连接 failed replaces 链", async () => {
    const replacementId = artifactId("artifact_replacement");
    const replacementVersion = resourceVersionId("resource_version_replacement");
    repository.beginResult = {
      outcome: "started",
      publication: publication({
        artifactId: replacementId,
        resourceVersionId: replacementVersion,
        replacesArtifactId: artifactOne,
      }),
      binding: binding({
        resourceVersionId: replacementVersion,
        blob: stableBlob({ sha256: "b".repeat(64) }),
      }),
    };
    vi.mocked(blobs.head).mockResolvedValueOnce({
      blob: stableBlob({ sha256: "b".repeat(64) }),
    });
    repository.finishResult = {
      outcome: "applied",
      publication: publication({
        artifactId: replacementId,
        resourceVersionId: replacementVersion,
        replacesArtifactId: artifactOne,
        status: "published",
      }),
    };

    await expect(
      service.publishArtifact(
        publishCommand({
          artifactId: replacementId,
          resourceVersionId: replacementVersion,
          replacesArtifactId: artifactOne,
          idempotencyKey: "publish:run_alpha:report:2",
        }),
      ),
    ).resolves.toMatchObject({ replacesArtifactId: artifactOne, status: "published" });

    repository.beginResult = { outcome: "invalid_replacement" };
    await expect(
      service.publishArtifact(
        publishCommand({
          artifactId: replacementId,
          resourceVersionId: replacementVersion,
          replacesArtifactId: artifactOne,
          idempotencyKey: "publish:run_alpha:report:3",
        }),
      ),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_IDEMPOTENCY_CONFLICT"));
  });

  it("声明 required/optional 后，只有 required 的缺失、publishing 或 failed 阻止完成", async () => {
    await service.declareDeliverables(
      declarationInput({
        idempotencyKey: "declare:run_alpha:1",
        declarations: [
          { key: "report", name: "报告", requirement: "required" },
          { key: "appendix", name: "附录", requirement: "optional" },
        ],
      }),
    );
    expect(repository.declareInputs[0]?.declarations).toEqual([
      { key: "report", name: "报告", requirement: "required" },
      { key: "appendix", name: "附录", requirement: "optional" },
    ]);

    for (const status of ["missing", "publishing", "failed"] as const) {
      repository.completionResult = {
        outcome: "not_ready",
        blockers: [{ deliverableKey: "report", status }],
      };
      await expect(service.assertReadyForCompletion({ scope })).rejects.toSatisfy((error) =>
        expectCode(error, "ARTIFACT_NOT_READY"),
      );
    }
    repository.completionResult = { outcome: "ready" };
    await expect(service.assertReadyForCompletion({ scope })).resolves.toBeUndefined();
  });

  it("声明响应丢失按摘要 readback；重复键和非法用途在访问 Repository 前拒绝", async () => {
    repository.declarationResult = { outcome: "response_unknown" };
    repository.declarationReadback = {
      outcome: "already_applied",
      commandDigest: placeholderDigest,
    };
    await expect(
      service.declareDeliverables(
        declarationInput({
          idempotencyKey: "declare:run_alpha:2",
          declarations: [{ key: "report", name: "报告", requirement: "required" }],
        }),
      ),
    ).resolves.toBeUndefined();
    expect(repository.declarationReadInputs[0]?.authorization).toBe(
      repository.declareInputs[0]?.authorization,
    );

    await expect(
      service.declareDeliverables(
        declarationInput({
          idempotencyKey: "declare:run_alpha:3",
          declarations: [
            { key: "report", name: "甲", requirement: "required" },
            { key: "report", name: "乙", requirement: "optional" },
          ],
        }),
      ),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_INVALID_ARGUMENT"));
    await expect(
      service.publishArtifact(publishCommand({ purpose: "diagnostic" })),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_INVALID_ARGUMENT"));
  });

  it("Artifact 名称拒绝 Cc/Cf，包括双向覆盖、隔离符和零宽格式字符", async () => {
    for (const character of [
      "\u0000",
      "\u202E",
      "\u2066",
      "\u2067",
      "\u2068",
      "\u2069",
      "\u200B",
    ]) {
      await expect(
        service.publishArtifact(publishCommand({ name: `报告${character}.txt` })),
      ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_INVALID_ARGUMENT"));
    }
    expect(repository.beginInputs).toHaveLength(0);
  });

  it("未知 Repository 异常统一脱敏，完成门固定为 ARTIFACT_NOT_READY", async () => {
    repository.beginPublication = async () => {
      throw new Error("postgres://secret@internal/object-key");
    };
    await expect(service.publishArtifact(publishCommand())).rejects.toEqual(
      expect.objectContaining({
        code: "ARTIFACT_DEPENDENCY_UNAVAILABLE",
        message: "Artifact 服务暂时不可用",
      }),
    );
    repository.inspectCompletion = async () => {
      throw new Error("database private detail");
    };
    await expect(service.assertReadyForCompletion({ scope })).rejects.toEqual(
      expect.objectContaining({
        code: "ARTIFACT_NOT_READY",
        message: "必需交付物尚未全部发布成功",
      }),
    );
  });
});

describe("ArtifactDeliveryService 用户投影与授权下载", () => {
  let repository: FakeRepository;
  let blobs: BlobStore;
  let service: ArtifactDeliveryService;

  beforeEach(() => {
    repository = new FakeRepository();
    blobs = fakeBlobStore();
    service = new ArtifactDeliveryService(repository, blobs, {
      defaultDownloadTtlSeconds: 120,
      maxDownloadTtlSeconds: 300,
      monotonicClock: immediateMonotonicClock,
    });
  });

  it("交付列表只返回 published Deliverable，纵使适配器误混入 Diagnostic/Trace", async () => {
    repository.listed = [
      publication({ status: "published" }),
      processPublication("diagnostic", artifactId("artifact_diag")),
      processPublication("trace", artifactId("artifact_trace")),
      publication({ artifactId: artifactId("artifact_pending"), status: "publishing" }),
      publication({ artifactId: artifactId("artifact_failed"), status: "failed" }),
      publication({
        artifactId: artifactId("artifact_other_tenant"),
        tenantId: tenantId("tenant_other"),
        status: "published",
      }),
      publication({
        artifactId: artifactId("artifact_other_run"),
        runId: runId("run_other"),
        status: "published",
      }),
    ];
    await expect(service.listDeliverables({ request, runId: scope.runId })).resolves.toEqual([
      expect.objectContaining({
        artifactId: artifactOne,
        purpose: "deliverable",
        status: "published",
      }),
    ]);
  });

  it("下载只接受 Artifact ID，服务端固定 Blob、媒体类型、安全文件名与短 TTL", async () => {
    repository.download = {
      ...repository.download,
      publication: publication({ name: '../最终"报告?.txt', status: "published" }),
      binding: binding({ mediaType: "application/pdf" }),
    };
    const result = await service.createDownload({ request, artifactId: artifactOne });
    expect(result).toMatchObject({
      artifactId: artifactOne,
      expiresInSeconds: 120,
      mediaType: "application/pdf",
    });
    expect(result.fileName).not.toMatch(/[\\/"?]/u);
    expect(blobs.presignDownload).toHaveBeenCalledWith({
      scope: { tenantId: scope.tenantId },
      blob: repository.download.binding.blob,
      ttlSeconds: 120,
      responseMediaType: "application/pdf",
      delivery: "artifact-download",
      downloadName: result.fileName,
    });
  });

  it("下载拒绝持久快照中的 Cc/Cf，并防御 Windows 保留设备名", async () => {
    for (const character of ["\u0000", "\u202E", "\u2066", "\u2069", "\u200B"]) {
      repository.download = {
        ...repository.download,
        publication: publication({ name: `报告${character}.txt`, status: "published" }),
      };
      await expect(service.createDownload({ request, artifactId: artifactOne })).rejects.toSatisfy(
        (error) => expectCode(error, "ARTIFACT_DEPENDENCY_UNAVAILABLE"),
      );
    }
    expect(blobs.presignDownload).not.toHaveBeenCalled();

    repository.download = {
      ...repository.download,
      publication: publication({ name: "CON.txt", status: "published" }),
    };
    await expect(
      service.createDownload({ request, artifactId: artifactOne }),
    ).resolves.toMatchObject({
      fileName: "_CON.txt",
    });
    expect(blobs.presignDownload).toHaveBeenLastCalledWith(
      expect.objectContaining({ downloadName: "_CON.txt" }),
    );
  });

  it("猜 ID、跨 Tenant、用户错配都返回同一不泄漏存在性的错误", async () => {
    repository.downloadOutcome = "not_found";
    await expect(
      service.createDownload({ request, artifactId: artifactId("artifact_guessed") }),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_NOT_FOUND"));

    repository.downloadOutcome = "authorized";
    repository.download = {
      ...repository.download,
      authorization: {
        ...repository.download.authorization,
        scope: { tenantId: tenantId("tenant_other"), userId: userId("user_other") },
      },
    };
    await expect(service.createDownload({ request, artifactId: artifactOne })).rejects.toSatisfy(
      (error) => expectCode(error, "ARTIFACT_NOT_FOUND"),
    );
    expect(blobs.presignDownload).not.toHaveBeenCalled();
  });

  it("签名期间 Artifact 状态或版本漂移时不返回已经生成的 URL", async () => {
    repository.confirmOutcome = "changed";
    await expect(service.createDownload({ request, artifactId: artifactOne })).rejects.toSatisfy(
      (error) => expectCode(error, "ARTIFACT_NOT_FOUND"),
    );
    expect(blobs.presignDownload).toHaveBeenCalledTimes(1);

    repository.confirmOutcome = "confirmed";
    repository.download = {
      ...repository.download,
      binding: binding({ resourceVersionId: resourceVersionId("resource_version_drift") }),
    };
    vi.mocked(blobs.presignDownload).mockClear();
    await expect(service.createDownload({ request, artifactId: artifactOne })).rejects.toSatisfy(
      (error) => expectCode(error, "ARTIFACT_NOT_FOUND"),
    );
    expect(blobs.presignDownload).not.toHaveBeenCalled();
  });

  it("签名端口异常或畸形返回统一脱敏，默认拒绝明文 HTTP", async () => {
    vi.mocked(blobs.presignDownload)
      .mockRejectedValueOnce(new Error("X-Amz-Signature=private"))
      .mockResolvedValueOnce("javascript:alert(1)")
      .mockResolvedValueOnce("http://minio.internal/private");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.createDownload({ request, artifactId: artifactOne })).rejects.toEqual(
        expect.objectContaining({
          code: "ARTIFACT_DEPENDENCY_UNAVAILABLE",
          message: "Artifact 服务暂时不可用",
        }),
      );
    }
  });

  it("下载 TTL 配置有硬上限，本地 HTTP 必须显式开启", async () => {
    expect(
      () =>
        new ArtifactDeliveryService(repository, blobs, {
          maxDownloadTtlSeconds: 901,
          monotonicClock: immediateMonotonicClock,
        }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID_ARGUMENT" }));
    expect(
      () =>
        new ArtifactDeliveryService(repository, blobs, {
          allowInsecureHttpDownload: true,
          monotonicClock: immediateMonotonicClock,
        }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID_ARGUMENT" }));

    vi.mocked(blobs.presignDownload).mockResolvedValueOnce("http://127.0.0.1:9000/signed");
    const localService = new ArtifactDeliveryService(repository, blobs, {
      defaultDownloadTtlSeconds: 60,
      runtimeMode: "development",
      allowInsecureHttpDownload: true,
      monotonicClock: immediateMonotonicClock,
    });
    await expect(
      localService.createDownload({ request, artifactId: artifactOne }),
    ).resolves.toMatchObject({
      expiresInSeconds: 60,
    });
  });
});
