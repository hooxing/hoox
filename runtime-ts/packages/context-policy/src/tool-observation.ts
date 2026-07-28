import { createHash } from "node:crypto";

/**
 * 完整 Tool 输出的持久化端口。实现必须在返回 persisted 前完成 stable/trace Blob 的
 * 校验和引用提交；不能把“已发起上传”误报为“已保存”。
 */
export interface TraceBlobPersistencePort {
  persistTrace(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly body: Uint8Array;
    readonly sha256: string;
  }): Promise<TraceBlobPersistenceResult>;
}

export type TraceBlobPersistenceResult =
  | {
      readonly outcome: "persisted" | "replayed";
      readonly referenceId: string;
      readonly blob: StableTraceBlobIdentity;
    }
  | { readonly outcome: "conflict" | "unavailable" | "unknown" };

/** 不可伪造的 stable identity 必须同时绑定租户、用途、incarnation 与物理键。 */
export interface StableTraceBlobIdentity {
  readonly kind: "stable";
  readonly tenantId: string;
  readonly purpose: "trace";
  readonly sha256: string;
  readonly size: number;
  readonly incarnationId: string;
  readonly physicalObjectKey: string;
}

export interface ToolObservationRolloutPort {
  appendToolResult(input: {
    readonly idempotencyKey: string;
    readonly toolCallId: string;
    readonly body: Readonly<Record<string, unknown>>;
    readonly isTruncated: boolean;
    readonly blob: { readonly referenceId: string; readonly sha256: string; readonly size: number };
  }): Promise<{
    readonly outcome: "created" | "replayed" | "conflict" | "unavailable" | "unknown";
  }>;
}

export interface ToolObservationInput {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly toolCallId: string;
  readonly toolName: string;
  /** 只能由实际 Tool adapter 在完成错误脱敏后构造。 */
  readonly trustedOutput: TrustedToolOutput;
}

declare const trustedToolOutputBrand: unique symbol;
export type TrustedToolOutput = string & { readonly [trustedToolOutputBrand]: true };

/** 这是进入 Observation 管线的显式信任边界；调用点必须先完成错误脱敏。 */
export function trustedToolOutputFromSanitizedAdapter(output: string): TrustedToolOutput {
  if (typeof output !== "string") throw new TypeError("Tool 输出必须是字符串");
  return output as TrustedToolOutput;
}

export interface ToolObservationPolicy {
  /** 模型看到的 observation 的 UTF-8 总字节上限，包含“已保存”占位符。 */
  readonly maxModelObservationBytes: number;
  /** Rollout body 独立硬上限；不得借模型预算放大持久事实。 */
  readonly maxRolloutBodyBytes?: number;
}

export type ToolObservationResult =
  | {
      readonly outcome: "recorded" | "replayed";
      readonly observation: string;
      readonly isTruncated: boolean;
    }
  | { readonly outcome: "conflict" | "unavailable" | "unknown" };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PHYSICAL_KEY = /^[\x21-\x7e]{1,1024}$/u;
const TRUNCATED_PREFIX = "[完整输出已保存，以下为截断内容]\n";

/**
 * 把“保存完整事实”和“投影给模型”拆成不能倒置的两个阶段。即使输出很小也先保存，
 * 因而重启后可以从 Rollout 的 stable trace Blob 重建同一观察结果。
 */
export class ToolObservationPipeline {
  readonly #maxModelObservationBytes: number;
  readonly #maxRolloutBodyBytes: number;

  constructor(
    private readonly traces: TraceBlobPersistencePort,
    private readonly rollout: ToolObservationRolloutPort,
    policy: ToolObservationPolicy,
  ) {
    if (
      !Number.isSafeInteger(policy.maxModelObservationBytes) ||
      policy.maxModelObservationBytes < 1
    ) {
      throw new TypeError("模型 Observation UTF-8 预算必须是正整数");
    }
    this.#maxModelObservationBytes = policy.maxModelObservationBytes;
    this.#maxRolloutBodyBytes = boundedRolloutBudget(policy.maxRolloutBodyBytes ?? 16 * 1024);
  }

  async record(input: ToolObservationInput): Promise<ToolObservationResult> {
    assertInput(input);
    const bytes = Buffer.from(input.trustedOutput, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const persisted = await this.traces.persistTrace({
      tenantId: input.tenantId,
      idempotencyKey: `${input.idempotencyKey}.trace`,
      body: bytes,
      sha256,
    });
    if (!isPersistedTrace(persisted)) {
      // 失败/未知时绝不将完整输出放进 Rollout，也不向模型宣称它已经保存。
      return persisted;
    }
    assertPersistedTrace(input.tenantId, sha256, bytes.byteLength, persisted);

    const buildBody = (rendered: { readonly observation: string; readonly isTruncated: boolean }) =>
      Object.freeze({
        schemaVersion: 1,
        toolName: input.toolName,
        rawOutputSha256: sha256,
        rawOutputBytes: bytes.byteLength,
        traceBlob: Object.freeze({
          referenceId: persisted.referenceId,
          incarnationId: persisted.blob.incarnationId,
        }),
        truncation: Object.freeze({
          isTruncated: rendered.isTruncated,
          ...(rendered.isTruncated ? { reason: "model_utf8_budget_or_rollout_body_budget" } : {}),
          modelVisibleBytes: Buffer.byteLength(rendered.observation, "utf8"),
        }),
        observation: rendered.observation,
      });
    const rendered = fitObservationToBothBudgets(
      input.trustedOutput,
      this.#maxModelObservationBytes,
      this.#maxRolloutBodyBytes,
      buildBody,
    );
    const body = buildBody(rendered);
    const appended = await this.rollout.appendToolResult({
      idempotencyKey: `${input.idempotencyKey}.rollout`,
      toolCallId: input.toolCallId,
      body,
      isTruncated: rendered.isTruncated,
      blob: { referenceId: persisted.referenceId, sha256, size: bytes.byteLength },
    });
    if (appended.outcome !== "created" && appended.outcome !== "replayed") {
      return { outcome: appended.outcome as "conflict" | "unavailable" | "unknown" };
    }
    return { outcome: appended.outcome === "created" ? "recorded" : "replayed", ...rendered };
  }
}

function isPersistedTrace(
  result: TraceBlobPersistenceResult,
): result is Extract<TraceBlobPersistenceResult, { readonly outcome: "persisted" | "replayed" }> {
  return result.outcome === "persisted" || result.outcome === "replayed";
}

function assertInput(input: ToolObservationInput): void {
  for (const [label, value] of [
    ["Tenant ID", input.tenantId],
    ["幂等键", input.idempotencyKey],
    ["Tool call ID", input.toolCallId],
    ["Tool 名称", input.toolName],
  ] as const) {
    if (!SAFE_ID.test(value)) throw new TypeError(`${label}格式无效`);
  }
  if (typeof input.trustedOutput !== "string") throw new TypeError("Tool 输出必须来自受信适配边界");
}

function assertPersistedTrace(
  tenantId: string,
  sha256: string,
  size: number,
  result: Extract<TraceBlobPersistenceResult, { readonly outcome: "persisted" | "replayed" }>,
): void {
  const { blob } = result;
  if (
    !SAFE_ID.test(result.referenceId) ||
    blob.kind !== "stable" ||
    blob.tenantId !== tenantId ||
    blob.purpose !== "trace" ||
    blob.sha256 !== sha256 ||
    blob.size !== size ||
    !SAFE_ID.test(blob.incarnationId) ||
    !PHYSICAL_KEY.test(blob.physicalObjectKey) ||
    !SHA256.test(blob.sha256)
  ) {
    throw new Error("Trace Blob 持久化端口返回了无效 stable 身份");
  }
}

function renderObservation(
  output: string,
  budget: number,
): { readonly observation: string; readonly isTruncated: boolean } {
  const outputBytes = Buffer.byteLength(output, "utf8");
  if (outputBytes <= budget) return { observation: output, isTruncated: false };
  // 标记只有完整装得下才出现；返回半个“[”会误导模型且不构成有效协议。
  const prefix = Buffer.byteLength(TRUNCATED_PREFIX, "utf8") <= budget ? TRUNCATED_PREFIX : "";
  const remainder = Math.max(0, budget - Buffer.byteLength(prefix, "utf8"));
  const content = truncateUtf8(output, remainder);
  const observation = `${prefix}${content}`;
  // 这是阻止未来重构把 metadata/占位符计入错误预算的最终防线。
  if (Buffer.byteLength(observation, "utf8") > budget)
    throw new Error("Observation 超出 UTF-8 预算");
  return { observation, isTruncated: true };
}

function boundedRolloutBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 512 || value > 16 * 1024) {
    throw new TypeError("Rollout body UTF-8 预算必须在 512 到 16384 字节之间");
  }
  return value;
}

function fitObservationToBothBudgets(
  output: string,
  modelBudget: number,
  rolloutBudget: number,
  bodyFor: (rendered: {
    readonly observation: string;
    readonly isTruncated: boolean;
  }) => Readonly<Record<string, unknown>>,
): { readonly observation: string; readonly isTruncated: boolean } {
  let low = 0;
  let high = modelBudget;
  let best = renderObservation(output, 0);
  while (low <= high) {
    const candidateBudget = Math.floor((low + high) / 2);
    const candidate = renderObservation(output, candidateBudget);
    const size = Buffer.byteLength(JSON.stringify(bodyFor(candidate)), "utf8");
    if (size <= rolloutBudget) {
      best = candidate;
      low = candidateBudget + 1;
    } else {
      high = candidateBudget - 1;
    }
  }
  if (Buffer.byteLength(JSON.stringify(bodyFor(best)), "utf8") > rolloutBudget) {
    throw new Error("Tool result metadata 无法装入 Rollout body 硬上限");
  }
  return best;
}

/** 按 Unicode code point 逐个加入，绝不切开 emoji 或其他 UTF-8 多字节字符。 */
function truncateUtf8(value: string, budget: number): string {
  let used = 0;
  let result = "";
  for (const point of value) {
    const bytes = Buffer.byteLength(point, "utf8");
    if (used + bytes > budget) break;
    result += point;
    used += bytes;
  }
  return result;
}
