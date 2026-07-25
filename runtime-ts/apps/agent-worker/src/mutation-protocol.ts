import { sha256Digest, type Sha256Digest } from "@cube-runtime/domain";
import type { RuntimeMutation, RuntimeOutboxV1, ValidatedWorkspaceChange } from "./ports.js";
import type { ControlledRolloutProjection } from "@cube-runtime/pi-adapter";
import { createHash } from "node:crypto";

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

export function outboxPayloadDigest(outbox: RuntimeOutboxV1): Sha256Digest {
  return digest({
    schemaVersion: outbox.schemaVersion,
    kind: outbox.kind,
    idempotencyKey: outbox.idempotencyKey,
    state: outbox.state,
    ...(outbox.kind === "sandbox_cleanup" && outbox.state === "pending"
      ? { armed: outbox.armed }
      : {}),
    payload: outbox.payload,
  });
}

export function rolloutProjectionDigest(projection: ControlledRolloutProjection): Sha256Digest {
  return digest(projection);
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
