import {
  artifactId,
  resourceVersionId,
  runId,
  tenantId,
  threadId,
  userId,
  workspaceId,
} from "@cube-runtime/domain";
import type { BlobStore, StableBlobRef } from "@cube-runtime/persistence";
import type { ExecutionScope } from "@cube-runtime/run-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  return {
    scope,
    idempotencyKey: "publish:run_alpha:report:1",
    artifactId: artifactOne,
    resourceVersionId: versionOne,
    name: "最终报告.txt",
    purpose: "deliverable",
    deliverableKey: "report",
    ...overrides,
  };
}

class FakeRepository implements ArtifactDeliveryRepositoryPort {
  declarationResult: DeclareDeliverablesResult = {
    outcome: "applied",
    commandDigest: "由调用时填写",
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

  async readDeliverableDeclarationCommand(): Promise<
    DeclareDeliverablesResult | { readonly outcome: "not_found" }
  > {
    if (
      this.declarationReadback.outcome === "applied" ||
      this.declarationReadback.outcome === "already_applied"
    ) {
      const last = this.declareInputs.at(-1);
      return {
        ...this.declarationReadback,
        commandDigest:
          this.declarationReadback.commandDigest === "由调用时填写"
            ? (last?.commandDigest ?? "missing")
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
    service = new ArtifactDeliveryService(repository, blobs);
  });

  it("固定 running Run、ResourceVersion 与 Blob 身份后发布，并允许同摘要幂等读回", async () => {
    await expect(service.publishArtifact(publishCommand())).resolves.toMatchObject({
      artifactId: artifactOne,
      status: "published",
    });
    expect(repository.beginInputs[0]).toMatchObject({
      scope,
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

  it("发布响应丢失时只按相同命令摘要 readback，不重复制造 Artifact", async () => {
    repository.finishResult = { outcome: "response_unknown" };
    repository.readResult = {
      outcome: "found",
      commandDigest: "稍后替换",
      publication: publication({ status: "published" }),
      binding: binding(),
    };
    repository.readPublicationCommand = async (
      input: Parameters<ArtifactDeliveryRepositoryPort["readPublicationCommand"]>[0],
    ) => ({
      ...(repository.readResult as Extract<ReadArtifactPublicationResult, { outcome: "found" }>),
      commandDigest:
        repository.finishInputs.find(
          (candidate) => candidate.idempotencyKey === input.idempotencyKey,
        )?.commandDigest ?? "missing",
    });

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
        )?.commandDigest ?? "missing",
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
    await service.declareDeliverables({
      scope,
      idempotencyKey: "declare:run_alpha:1",
      declarations: [
        { key: "report", name: "报告", requirement: "required" },
        { key: "appendix", name: "附录", requirement: "optional" },
      ],
    });
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
    repository.declarationReadback = { outcome: "already_applied", commandDigest: "由调用时填写" };
    await expect(
      service.declareDeliverables({
        scope,
        idempotencyKey: "declare:run_alpha:2",
        declarations: [{ key: "report", name: "报告", requirement: "required" }],
      }),
    ).resolves.toBeUndefined();

    await expect(
      service.declareDeliverables({
        scope,
        idempotencyKey: "declare:run_alpha:3",
        declarations: [
          { key: "report", name: "甲", requirement: "required" },
          { key: "report", name: "乙", requirement: "optional" },
        ],
      }),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_INVALID_ARGUMENT"));
    await expect(
      service.publishArtifact(publishCommand({ purpose: "diagnostic" })),
    ).rejects.toSatisfy((error) => expectCode(error, "ARTIFACT_INVALID_ARGUMENT"));
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
      () => new ArtifactDeliveryService(repository, blobs, { maxDownloadTtlSeconds: 901 }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID_ARGUMENT" }));
    expect(
      () => new ArtifactDeliveryService(repository, blobs, { allowInsecureHttpDownload: true }),
    ).toThrowError(expect.objectContaining({ code: "ARTIFACT_INVALID_ARGUMENT" }));

    vi.mocked(blobs.presignDownload).mockResolvedValueOnce("http://127.0.0.1:9000/signed");
    const localService = new ArtifactDeliveryService(repository, blobs, {
      defaultDownloadTtlSeconds: 60,
      runtimeMode: "development",
      allowInsecureHttpDownload: true,
    });
    await expect(
      localService.createDownload({ request, artifactId: artifactOne }),
    ).resolves.toMatchObject({
      expiresInSeconds: 60,
    });
  });
});
