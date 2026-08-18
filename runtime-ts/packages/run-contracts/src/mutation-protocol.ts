import { createHash } from "node:crypto";
import { assertControlledToolObservation, parseControlledToolReceipt } from "@hoox/context-policy";
import { type IsoTimestamp, type Sha256Digest, sha256Digest } from "@hoox/domain";
import type { ControlledRolloutProjection } from "@hoox/pi-adapter";
import type { RuntimeMutation, RuntimeOutboxV1, ValidatedWorkspaceChange } from "./ports.js";

/**
 * 幂等 digest 排除会随续租变化的 expiresAt，只绑定 scope、栅栏身份、版本和业务 payload。
 * canonical JSON 对对象键排序，对数组保序，保证 PG/Fake/Worker 可独立重算同一摘要。
 */
export function runtimeMutationDigest(
  command: Omit<RuntimeMutation, "commandDigest">,
): Sha256Digest {
  return digest({
    ...command,
    fence: {
      scope: command.fence.scope,
      runClaim: {
        token: command.fence.runClaim.token,
        epoch: command.fence.runClaim.epoch,
      },
      workspaceLease: {
        rootRunId: command.fence.workspaceLease.rootRunId,
        epoch: command.fence.workspaceLease.epoch,
      },
    },
  });
}

/**
 * API 已先把 Run 标记为 cancelled 时，只允许原 Worker 用原栅栏提交这一种终态收尾。
 * 该窄门禁止在取消后继续写模型事件、Workspace 或 Rollout；可选 cleanup started 仅用于
 * 把已 armed 的 Sandbox 交给持久清理消费者。
 */
export function isExternalCancellationFinalizationMutation(
  command: RuntimeMutation,
  attemptId: string,
): boolean {
  const [notice, attempt] = command.events;
  return (
    command.idempotencyKey === `${attemptId}/final/cancelled` &&
    command.nextAttemptStatus === "cancelled" &&
    command.nextStage === "finished" &&
    command.nextRunStatus === "cancelled" &&
    command.releaseFences === true &&
    command.effectInvocation === undefined &&
    command.rolloutProjection === undefined &&
    command.expectedProjectionVersion === undefined &&
    command.workspaceChange === undefined &&
    command.threadSteer === undefined &&
    command.events.length === 2 &&
    notice?.kind === "agent_event" &&
    notice.payload.type === "runtime.notice" &&
    notice.payload.code === "CANCELLED" &&
    attempt?.kind === "attempt_state_changed" &&
    attempt.payload.status === "cancelled" &&
    attempt.payload.stage === "finished" &&
    attempt.payload.code === "CANCELLED" &&
    command.outbox.length <= 1 &&
    command.outbox.every(
      (item) =>
        item.kind === "sandbox_cleanup" &&
        item.state === "started" &&
        item.payload.disposition === "close",
    )
  );
}

export function outboxPayloadDigest(outbox: RuntimeOutboxV1, armedAt?: IsoTimestamp): Sha256Digest {
  if (outbox.kind === "sandbox_cleanup" && armedAt === undefined) {
    throw new Error("cleanup receipt digest 必须包含 armedAt");
  }
  return digest({
    schemaVersion: outbox.schemaVersion,
    kind: outbox.kind,
    idempotencyKey: outbox.idempotencyKey,
    state: outbox.state,
    ...(outbox.kind === "sandbox_cleanup" ? { armed: outbox.armed, armedAt } : {}),
    payload: outbox.payload,
  });
}

export function sandboxCleanupIdentityDigest(
  outbox: Extract<RuntimeOutboxV1, { kind: "sandbox_cleanup" }>,
): Sha256Digest {
  return digest({
    registryId: outbox.payload.registryId,
    providerKey: outbox.payload.providerKey,
    providerSandboxId: outbox.payload.providerSandboxId,
  });
}

export function rolloutProjectionDigest(projection: ControlledRolloutProjection): Sha256Digest {
  assertControlledRolloutProjection(projection);
  return digest(projection);
}

/**
 * Projection 是跨 API、持久化和 Worker 的不可信边界；三处必须使用同一套规则，
 * 否则持久化的恢复快照可能在 Worker 启动后才被拒绝。
 */
export function assertControlledRolloutProjection(projection: ControlledRolloutProjection): void {
  if (
    projection.schemaVersion !== 2 ||
    !projection.checkpointId.trim() ||
    Buffer.byteLength(projection.checkpointId, "utf8") > 200 ||
    projection.items.length > 200
  ) {
    throw new Error("受控上下文投影无效");
  }
  let totalBytes = 0;
  for (const item of projection.items) {
    if (item.kind === "tool_receipt") {
      try {
        const receipt = parseControlledToolReceipt(
          JSON.stringify({
            schemaVersion: 1,
            trust: "sandbox_untrusted",
            toolName: item.toolName,
            outcome: item.outcome,
            message: item.outcome === "succeeded" ? "工具调用已完成。" : "工具调用未完成。",
          }),
        );
        assertControlledToolObservation({
          receipt,
          observation: item.observation,
          isTruncated: item.isTruncated,
          modelVisibleBytes: item.modelVisibleBytes,
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(item.toolCallId)) throw new Error();
      } catch {
        throw new Error("受控上下文投影无效");
      }
      totalBytes += Buffer.byteLength(item.observation, "utf8");
      continue;
    }
    if (item.kind !== "turn" || (item.role !== "user" && item.role !== "assistant")) {
      throw new Error("受控上下文投影无效");
    }
    const text = item.text.trim();
    const textBytes = Buffer.byteLength(text, "utf8");
    if (
      !text ||
      textBytes > 16 * 1024 ||
      /(?:[A-Za-z]:[\\/]|\/(?:home|Users|var\/lib|opt|srv)\/)/u.test(text)
    ) {
      throw new Error("受控上下文投影无效");
    }
    totalBytes += textBytes;
  }
  if (totalBytes > 64 * 1024 || Buffer.byteLength(JSON.stringify(projection), "utf8") > 64 * 1024) {
    throw new Error("受控上下文投影无效");
  }
}

export function workspaceChangeDigest(change: ValidatedWorkspaceChange): Sha256Digest {
  return digest(change);
}

export function digestCanonical(value: unknown): Sha256Digest {
  return digest(value);
}

function digest(value: unknown): Sha256Digest {
  const encoded = JSON.stringify(canonical(value));
  return sha256Digest(createHash("sha256").update(encoded).digest("hex"));
}

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("digest 不接受非有限数字");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  throw new Error("digest 只接受可序列化协议值");
}
