import { createHash } from "node:crypto";
import type { UserId } from "@aisay/domain";
import { SkillServiceError, skillInvariant } from "./errors.js";
import type {
  SkillPublicationAuthorizationPort,
  SkillPublicationCommandResult,
  SkillPublicationPage,
  SkillPublicationPort,
  SkillPublicationRole,
  SkillPublicationSubmission,
  SkillPublicationUploadFile,
  SkillPublicationMetadata,
} from "./publishing-contracts.js";
import { validateSkillPublicationPackage } from "./publishing-package.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export class SkillPublicationService {
  constructor(
    private readonly authorization: SkillPublicationAuthorizationPort,
    private readonly port: SkillPublicationPort,
  ) {}

  async list(input: {
    readonly userId: UserId;
    readonly limit?: number;
    readonly cursor?: string;
  }): Promise<SkillPublicationPage> {
    await this.requireRole(input.userId, ["publisher", "reviewer", "admin"]);
    const limit = input.limit ?? 30;
    assertVersionToken(limit - 1, "发布列表页大小无效");
    skillInvariant(limit >= 1 && limit <= 100, "INVALID_REQUEST", "发布列表页大小无效");
    if (input.cursor !== undefined) assertIdentifier(input.cursor, "发布列表游标无效");
    return callPort(() =>
      this.port.list({
        actorUserId: input.userId,
        limit,
        ...(input.cursor === undefined ? {} : { afterSubmissionId: input.cursor }),
      }),
    );
  }

  async get(userId: UserId, submissionId: string): Promise<SkillPublicationSubmission> {
    await this.requireRole(userId, ["publisher", "reviewer", "admin"]);
    assertIdentifier(submissionId, "发布申请 ID 无效");
    const submission = await callPort(() => this.port.get({ actorUserId: userId, submissionId }));
    if (submission === undefined) throw new SkillServiceError("NOT_FOUND", "发布申请不存在");
    return submission;
  }

  async create(input: {
    readonly userId: UserId;
    readonly submissionId: string;
    readonly metadata: SkillPublicationMetadata;
    readonly files: readonly SkillPublicationUploadFile[];
    readonly idempotencyKey: string;
  }): Promise<SkillPublicationSubmission> {
    await this.requireRole(input.userId, ["publisher", "admin"]);
    assertIdentifier(input.submissionId, "发布申请 ID 无效");
    assertIdempotencyKey(input.idempotencyKey);
    const packageInput = validateSkillPublicationPackage({
      metadata: input.metadata,
      files: input.files,
    });
    const result = await callPort(() =>
      this.port.create({
        actorUserId: input.userId,
        submissionId: input.submissionId,
        package: packageInput,
        idempotencyKey: input.idempotencyKey,
        // submissionId 由接入层生成，网络重试可能得到新值；幂等身份只绑定调用方请求的规范包。
        requestDigest: digest("create", [packageInput.packageDigest]),
      }),
    );
    if (result.outcome === "created" || result.outcome === "replayed") {
      return result.submission;
    }
    throw new SkillServiceError("CONFLICT", "Skill 规范键或版本已存在");
  }

  async submit(input: TransitionRequest): Promise<SkillPublicationSubmission> {
    await this.requireRole(input.userId, ["publisher", "admin"]);
    return this.transition(input, "submit", [], (request) => this.port.submit(request));
  }

  async review(
    input: TransitionRequest & {
      readonly decision: "approve" | "reject";
      readonly reason?: string;
    },
  ): Promise<SkillPublicationSubmission> {
    const role = await this.requireRole(input.userId, ["reviewer", "admin"]);
    if (input.decision === "reject") {
      assertReason(input.reason, "驳回必须填写原因");
    } else {
      skillInvariant(input.reason === undefined, "INVALID_REQUEST", "批准操作不能填写驳回原因");
    }
    if (role !== "admin") {
      const current = await this.get(input.userId, input.submissionId);
      skillInvariant(current.createdBy !== input.userId, "CONFLICT", "提交者不能审核自己的申请");
    }
    return this.transition(input, `review:${input.decision}`, [input.reason ?? null], (request) =>
      this.port.review({
        ...request,
        decision: input.decision,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    );
  }

  async publish(
    input: TransitionRequest & { readonly recommended: boolean },
  ): Promise<SkillPublicationSubmission> {
    await this.requireRole(input.userId, ["admin"]);
    return this.transition(input, "publish", [input.recommended], (request) =>
      this.port.publish({ ...request, recommended: input.recommended }),
    );
  }

  async revoke(
    input: TransitionRequest & { readonly reason: string },
  ): Promise<SkillPublicationSubmission> {
    await this.requireRole(input.userId, ["admin"]);
    assertReason(input.reason, "撤销必须填写原因");
    return this.transition(input, "revoke", [input.reason], (request) =>
      this.port.revoke({ ...request, reason: input.reason }),
    );
  }

  private async transition(
    input: TransitionRequest,
    operation: string,
    digestFields: readonly unknown[],
    execute: (
      request: Parameters<SkillPublicationPort["submit"]>[0],
    ) => Promise<SkillPublicationCommandResult>,
  ): Promise<SkillPublicationSubmission> {
    assertIdentifier(input.submissionId, "发布申请 ID 无效");
    assertVersionToken(input.expectedVersionToken, "发布申请版本令牌无效");
    assertIdempotencyKey(input.idempotencyKey);
    const result = await callPort(() =>
      execute({
        actorUserId: input.userId,
        submissionId: input.submissionId,
        expectedVersionToken: input.expectedVersionToken,
        idempotencyKey: input.idempotencyKey,
        requestDigest: digest(operation, [
          input.submissionId,
          input.expectedVersionToken,
          ...digestFields,
        ]),
      }),
    );
    if (result.outcome === "updated" || result.outcome === "replayed") return result.submission;
    if (result.outcome === "not_found") {
      throw new SkillServiceError("NOT_FOUND", "发布申请不存在");
    }
    throw new SkillServiceError("CONFLICT", "发布申请状态已经变化");
  }

  private async requireRole(
    userId: UserId,
    allowed: readonly SkillPublicationRole[],
  ): Promise<SkillPublicationRole> {
    skillInvariant(idPattern.test(userId), "INVALID_REQUEST", "管理员身份无效");
    const role = await callPort(() => this.authorization.resolveRole(userId));
    if (role === undefined || !allowed.includes(role)) {
      // 管理端对无权限主体隐藏能力是否存在，避免把平台运营身份变成可枚举信息。
      throw new SkillServiceError("NOT_FOUND", "管理员发布能力不存在");
    }
    return role;
  }
}

interface TransitionRequest {
  readonly userId: UserId;
  readonly submissionId: string;
  readonly expectedVersionToken: number;
  readonly idempotencyKey: string;
}

function assertIdentifier(value: string, message: string): void {
  skillInvariant(idPattern.test(value), "INVALID_REQUEST", message);
}

function assertVersionToken(value: number, message: string): void {
  skillInvariant(Number.isSafeInteger(value) && value >= 0, "INVALID_REQUEST", message);
}

function assertIdempotencyKey(value: string): void {
  skillInvariant(idempotencyKeyPattern.test(value), "INVALID_REQUEST", "幂等键无效");
}

function assertReason(value: string | undefined, message: string): asserts value is string {
  skillInvariant(
    value !== undefined &&
      value.trim() === value &&
      value.length >= 1 &&
      Buffer.byteLength(value, "utf8") <= 2_000 &&
      !hasControl(value),
    "INVALID_REQUEST",
    message,
  );
}

function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const point = character.codePointAt(0);
    return point !== undefined && (point <= 31 || point === 127);
  });
}

function digest(operation: string, fields: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...fields]))
    .digest("hex");
}

async function callPort<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof SkillServiceError) throw error;
    throw new SkillServiceError("DEPENDENCY_UNAVAILABLE", "管理员 Skill 发布服务暂时不可用");
  }
}
