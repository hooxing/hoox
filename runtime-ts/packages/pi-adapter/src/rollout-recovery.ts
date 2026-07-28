import type {
  RolloutCompatibilityIdentity,
  RuntimeRolloutCheckpoint,
  RuntimeRolloutEntry,
} from "@cube-runtime/domain";
import {
  type ControlledRolloutProjection,
  type CreateSafePiSessionOptions,
  createSafePiSession,
  type PiSessionController,
} from "./pi-session.js";

/**
 * 由持久事实重建的新 Pi Session 的输入。这里故意不接受 Pi 的 entry 或 session 文件：
 * Pi 是一次性模型投影，Runtime Rollout 才是重启后的唯一事实源。
 */
export interface RuntimeRecoveryFacts {
  readonly recordedCompatibility: RolloutCompatibilityIdentity;
  readonly checkpoint?: RuntimeRolloutCheckpoint;
  readonly tail: readonly RuntimeRolloutEntry[];
}

/** PgRuntimeRolloutRepository.loadRecovery 的 loaded 分支可直接交给此转换器；不引入持久层依赖环。 */
export interface LoadedRuntimeRecoveryFacts extends RuntimeRecoveryFacts {
  readonly outcome: "loaded";
}

export function runtimeRecoveryFactsFromLoaded(
  loaded: LoadedRuntimeRecoveryFacts,
): RuntimeRecoveryFacts {
  return Object.freeze({
    recordedCompatibility: loaded.recordedCompatibility,
    ...(loaded.checkpoint === undefined ? {} : { checkpoint: loaded.checkpoint }),
    tail: loaded.tail,
  });
}

export type RuntimeRecoveryProjectionResult =
  | { readonly outcome: "ready"; readonly projection: ControlledRolloutProjection }
  | {
      readonly outcome: "requires_tool_reconciliation";
      readonly pendingToolCallId: string;
    };

/** 恢复输入不兼容或已损坏时的稳定、无正文错误码。 */
export class RuntimeRecoveryError extends Error {
  constructor(readonly code: "COMPATIBILITY_MISMATCH" | "MALFORMED_FACTS") {
    super(code);
    this.name = "RuntimeRecoveryError";
  }
}

/**
 * 仅把已审核的 user/assistant 文本重新投影给全新的内存 Pi Session。
 * 工具事实仍保留在数据库；工具调用必须严格配对，尾部未配对时要求上层先恢复外部副作用，
 * 绝不凭空拼接一个 tool_result 来让模型继续。
 */
export function projectRuntimeRecovery(input: {
  readonly expectedCompatibility: RolloutCompatibilityIdentity;
  readonly facts: RuntimeRecoveryFacts;
}): RuntimeRecoveryProjectionResult {
  assertCompatibility(input.expectedCompatibility, input.facts.recordedCompatibility);
  const turns = input.facts.checkpoint === undefined ? [] : checkpointTurns(input.facts.checkpoint);
  const tail = [...input.facts.tail].sort((left, right) => left.sequence - right.sequence);
  let expectedSequence =
    input.facts.checkpoint === undefined ? 0 : input.facts.checkpoint.throughSequence + 1;
  let pendingToolCallId: string | undefined;
  let terminalSeen = false;
  for (const entry of tail) {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0) malformed();
    if (entry.sequence !== expectedSequence || terminalSeen) malformed();
    expectedSequence = entry.sequence + 1;
    if (pendingToolCallId !== undefined) {
      if (entry.kind !== "tool_result" || entry.toolCallId !== pendingToolCallId) malformed();
      pendingToolCallId = undefined;
      continue;
    }
    if (entry.kind === "tool_call") {
      if (!validCallId(entry.toolCallId)) malformed();
      pendingToolCallId = entry.toolCallId;
      continue;
    }
    if (entry.kind === "tool_result") malformed();
    if (entry.kind === "user" || entry.kind === "assistant") {
      turns.push({ role: entry.kind, text: entryText(entry) });
      continue;
    }
    // waiting/terminal 是 Worker 状态事实，不是可伪装成对话的模型输入。
    if (entry.kind !== "waiting" && entry.kind !== "terminal") malformed();
    terminalSeen = entry.kind === "terminal";
  }
  if (pendingToolCallId !== undefined) {
    return Object.freeze({ outcome: "requires_tool_reconciliation", pendingToolCallId });
  }
  return Object.freeze({
    outcome: "ready",
    projection: Object.freeze({
      schemaVersion: 1,
      checkpointId: input.facts.checkpoint?.checkpointId ?? "rollout-origin",
      turns: Object.freeze(turns.map((turn) => Object.freeze({ ...turn }))),
    }),
  });
}

/**
 * 该入口总会创建全新的 Pi Session；若恢复不可继续，会在创建 Session 前失败。
 * createSafePiSession 内部在 capability 漂移时负责 dispose，因此不会泄漏半初始化资源。
 */
export async function createRecoveredSafePiSession(
  options: Omit<CreateSafePiSessionOptions, "rolloutProjection"> & {
    readonly expectedCompatibility: RolloutCompatibilityIdentity;
    readonly facts: RuntimeRecoveryFacts;
  },
): Promise<PiSessionController> {
  const projected = projectRuntimeRecovery({
    expectedCompatibility: options.expectedCompatibility,
    facts: options.facts,
  });
  if (projected.outcome !== "ready") {
    throw new RuntimeRecoveryError("MALFORMED_FACTS");
  }
  return createSafePiSession({ ...options, rolloutProjection: projected.projection });
}

function checkpointTurns(
  checkpoint: RuntimeRolloutCheckpoint,
): Array<{ role: "user" | "assistant"; text: string }> {
  const projection = checkpoint.projection;
  if (
    !Number.isSafeInteger(checkpoint.windowStartSequence) ||
    !Number.isSafeInteger(checkpoint.throughSequence) ||
    checkpoint.windowStartSequence < 0 ||
    checkpoint.throughSequence < checkpoint.windowStartSequence ||
    projection.schemaVersion !== 1 ||
    typeof projection.checkpointId !== "string" ||
    projection.checkpointId !== checkpoint.checkpointId ||
    !Array.isArray(projection.turns)
  )
    malformed();
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

function entryText(entry: RuntimeRolloutEntry): string {
  if (!isRecord(entry.body) || typeof entry.body.text !== "string") malformed();
  return boundedText(entry.body.text);
}

function boundedText(value: string): string {
  const text = value.trim();
  if (!text || new TextEncoder().encode(text).byteLength > 16 * 1024) malformed();
  return text;
}

function validCallId(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
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
    throw new RuntimeRecoveryError("COMPATIBILITY_MISMATCH");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): never {
  throw new RuntimeRecoveryError("MALFORMED_FACTS");
}
