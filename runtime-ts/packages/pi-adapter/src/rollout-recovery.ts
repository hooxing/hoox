import { createHash } from "node:crypto";
import type { ContextBudgetDecision } from "@cube-runtime/context-policy";
import {
  type RolloutCompatibilityIdentity,
  type RuntimeRolloutCheckpoint,
  type RuntimeRolloutEntry,
  sha256Digest,
} from "@cube-runtime/domain";
import {
  assessSafePiSessionContext,
  type ControlledRolloutProjection,
  type CreateSafePiSessionOptions,
  createSafePiSession,
  deriveSafePiSessionCompatibility,
  type PiSessionController,
} from "./pi-session.js";

/** PgRuntimeRolloutRepository.loadRecovery 的公开结果形状；结构端口避免 pi-adapter 反向依赖 persistence。 */
export type RuntimeRolloutLoadRecoveryResult =
  | {
      readonly outcome: "loaded";
      readonly recordedCompatibility: RolloutCompatibilityIdentity;
      readonly checkpoint?: RuntimeRolloutCheckpoint;
      readonly tail: readonly RuntimeRolloutEntry[];
    }
  | {
      readonly outcome: "compatibility_mismatch";
      readonly action: "rebuild_attempt";
      readonly mismatches: readonly (
        | "modelId"
        | "modelCompatibilityHash"
        | "promptPolicyHash"
        | "toolSchemaHash"
        | "skillManifestHash"
      )[];
    }
  | { readonly outcome: "not_found" };

export type RuntimeRecoveryProjectionResult =
  | { readonly outcome: "ready"; readonly projection: ControlledRolloutProjection }
  | {
      readonly outcome: "requires_tool_reconciliation";
      readonly action: "reconcile_external_effect";
      readonly pendingToolCallId: string;
      readonly pendingToolCallSequence: number;
    };

export type RecoverSafePiSessionResult =
  | { readonly outcome: "session_created"; readonly controller: PiSessionController }
  | Exclude<RuntimeRolloutLoadRecoveryResult, { readonly outcome: "loaded" }>
  | Extract<RuntimeRecoveryProjectionResult, { readonly outcome: "requires_tool_reconciliation" }>
  | Exclude<ContextBudgetDecision, { readonly outcome: "ready" }>;

/** 恢复事实被篡改或已损坏时只公开稳定错误码，不回显正文、路径或内部身份。 */
export class RuntimeRecoveryError extends Error {
  constructor(readonly code: "MALFORMED_FACTS") {
    super(code);
    this.name = "RuntimeRecoveryError";
  }
}

/**
 * 唯一公开的 Session 恢复入口。当前五项身份从实际 Session 选项派生后交给 PG loadRecovery；
 * mismatch/rebuild 和未配对工具尾部均作为专门结果返回，并保证此时尚未创建 Pi Session。
 */
export async function recoverSafePiSession(
  options: Omit<CreateSafePiSessionOptions, "rolloutProjection"> & {
    readonly loadRecovery: (
      compatibility: RolloutCompatibilityIdentity,
    ) => Promise<RuntimeRolloutLoadRecoveryResult>;
  },
): Promise<RecoverSafePiSessionResult> {
  const sessionOptions = safeSessionOptions(options);
  const currentCompatibility = deriveSafePiSessionCompatibility(sessionOptions);
  const loaded = await options.loadRecovery(currentCompatibility);
  if (loaded.outcome !== "loaded") return loaded;
  assertCompatibility(currentCompatibility, loaded.recordedCompatibility);
  const projected = projectLoadedRuntimeRecovery(loaded);
  if (projected.outcome !== "ready") return projected;
  // 先做模型感知预算，再创建 Pi；超窗事实保留在 Rollout 中，调用方获得可处理的稳定结果。
  const budget = assessSafePiSessionContext({
    ...sessionOptions,
    rolloutProjection: projected.projection,
  });
  if (budget.outcome === "context_too_large") return budget;
  if (budget.outcome === "rebuild_required") return budget;
  const controller = await createSafePiSession({
    ...sessionOptions,
    rolloutProjection: projected.projection,
  });
  return Object.freeze({ outcome: "session_created", controller });
}

/** 纯事实投影器供持久层契约测试；它不能创建 Session，也不接受调用方自造兼容身份。 */
export function projectLoadedRuntimeRecovery(
  loaded: Extract<RuntimeRolloutLoadRecoveryResult, { readonly outcome: "loaded" }>,
): RuntimeRecoveryProjectionResult {
  const checkpoint = loaded.checkpoint;
  const turns = checkpoint === undefined ? [] : checkpointTurns(checkpoint);
  let expectedSequence = checkpoint === undefined ? 0 : checkpoint.throughSequence + 1;
  let pendingToolCall: { readonly id: string; readonly sequence: number } | undefined;
  let terminalSeen = false;
  // 不排序：数据库结果的顺序本身属于恢复协议，乱序输入必须失败关闭。
  for (const entry of loaded.tail) {
    validateEntryDigest(entry);
    if (
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence !== expectedSequence ||
      terminalSeen
    ) {
      malformed();
    }
    expectedSequence += 1;
    if (pendingToolCall !== undefined) {
      if (entry.kind !== "tool_result" || entry.toolCallId !== pendingToolCall.id) malformed();
      pendingToolCall = undefined;
      continue;
    }
    if (entry.kind === "tool_call") {
      if (!validCallId(entry.toolCallId)) malformed();
      pendingToolCall = { id: entry.toolCallId, sequence: entry.sequence };
      continue;
    }
    if (entry.kind === "tool_result") malformed();
    if (entry.kind === "user" || entry.kind === "assistant") {
      turns.push({ role: entry.kind, text: entryText(entry) });
      continue;
    }
    if (entry.kind !== "waiting" && entry.kind !== "terminal") malformed();
    terminalSeen = entry.kind === "terminal";
  }
  if (pendingToolCall !== undefined) {
    return Object.freeze({
      outcome: "requires_tool_reconciliation",
      action: "reconcile_external_effect",
      pendingToolCallId: pendingToolCall.id,
      pendingToolCallSequence: pendingToolCall.sequence,
    });
  }
  return Object.freeze({
    outcome: "ready",
    projection: Object.freeze({
      schemaVersion: 1,
      checkpointId: checkpoint?.checkpointId ?? "rollout-origin",
      turns: Object.freeze(turns.map((turn) => Object.freeze({ ...turn }))),
    }),
  });
}

function safeSessionOptions(
  options: Omit<CreateSafePiSessionOptions, "rolloutProjection"> & {
    readonly loadRecovery: unknown;
  },
): CreateSafePiSessionOptions {
  return {
    model: options.model,
    modelRuntime: options.modelRuntime,
    sandbox: options.sandbox,
    authorizeToolEffect: options.authorizeToolEffect,
    ...(options.untrustedPromptContent === undefined
      ? {}
      : { untrustedPromptContent: options.untrustedPromptContent }),
    ...(options.artifactToolRouter === undefined
      ? {}
      : { artifactToolRouter: options.artifactToolRouter }),
    ...(options.contextTokenizer === undefined
      ? {}
      : { contextTokenizer: options.contextTokenizer }),
    ...(options.contextBudget === undefined ? {} : { contextBudget: options.contextBudget }),
  };
}

function checkpointTurns(
  checkpoint: RuntimeRolloutCheckpoint,
): Array<{ role: "user" | "assistant"; text: string }> {
  if (
    !Number.isSafeInteger(checkpoint.windowStartSequence) ||
    !Number.isSafeInteger(checkpoint.throughSequence) ||
    checkpoint.windowStartSequence < 0 ||
    checkpoint.throughSequence < checkpoint.windowStartSequence ||
    canonicalDigest(checkpoint.projection) !== checkpoint.projectionDigest
  ) {
    malformed();
  }
  validateReplacementHistory(checkpoint);
  const projection = checkpoint.projection;
  if (
    projection.schemaVersion !== 1 ||
    projection.checkpointId !== checkpoint.checkpointId ||
    !Array.isArray(projection.turns)
  ) {
    malformed();
  }
  return projection.turns.map((turn) => {
    if (
      !isRecord(turn) ||
      (turn.role !== "user" && turn.role !== "assistant") ||
      typeof turn.text !== "string"
    ) {
      malformed();
    }
    return { role: turn.role, text: boundedText(turn.text) };
  });
}

function validateReplacementHistory(checkpoint: RuntimeRolloutCheckpoint): void {
  // 空数组是尚未发生窗口替换的合法前缀；一旦存在记录，最后一项必须描述当前窗口。
  if (checkpoint.replacementHistory.length === 0) return;
  let previousFrom = -1;
  let previousThrough = -1;
  for (const replacement of checkpoint.replacementHistory) {
    const keys = Object.keys(replacement).sort();
    if (keys.length !== 2 || keys[0] !== "from" || keys[1] !== "through") malformed();
    const from = replacement.from;
    const through = replacement.through;
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(through) ||
      (from as number) < 0 ||
      (through as number) < (from as number) ||
      (from as number) < previousFrom ||
      (through as number) < previousThrough
    ) {
      malformed();
    }
    previousFrom = from as number;
    previousThrough = through as number;
  }
  if (
    previousFrom !== checkpoint.windowStartSequence ||
    previousThrough !== checkpoint.throughSequence
  ) {
    malformed();
  }
}

function validateEntryDigest(entry: RuntimeRolloutEntry): void {
  if (canonicalDigest(entry.body) !== entry.bodyDigest) malformed();
}

function entryText(entry: RuntimeRolloutEntry): string {
  if (!isRecord(entry.body) || typeof entry.body.text !== "string") malformed();
  return boundedText(entry.body.text);
}

function boundedText(value: string): string {
  const text = value.trim();
  if (!text || new TextEncoder().encode(text).byteLength > 16 * 1024) malformed();
  return text;
}

function assertCompatibility(
  expected: RolloutCompatibilityIdentity,
  actual: RolloutCompatibilityIdentity,
): void {
  if (
    expected.modelId !== actual.modelId ||
    expected.modelCompatibilityHash !== actual.modelCompatibilityHash ||
    expected.promptPolicyHash !== actual.promptPolicyHash ||
    expected.toolSchemaHash !== actual.toolSchemaHash ||
    expected.skillManifestHash !== actual.skillManifestHash
  ) {
    malformed();
  }
}

function canonicalDigest(value: unknown) {
  const encoded = JSON.stringify(canonicalValue(value));
  return sha256Digest(createHash("sha256").update(encoded, "utf8").digest("hex"));
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) malformed();
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  malformed();
}

function validCallId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new RuntimeRecoveryError("MALFORMED_FACTS");
}
