import type { IsoTimestamp, RunId, Sha256Digest } from "@cube-runtime/domain";
import type {
  ConsumedExternalEffectAuthorization,
  ExecutionScope,
} from "@cube-runtime/run-contracts";
import { type ArtifactDeliveryError, artifactError } from "./errors.js";

const issuedAuthorizations = new WeakSet<object>();

export interface MonotonicClockPort {
  now(): number;
}

export const systemMonotonicClock: MonotonicClockPort = Object.freeze({
  now: () => performance.now(),
});

/**
 * 只能由已消费的 tool_execution permit 收窄得到。私有构造器与 WeakSet 共同确保普通 HTTP JSON
 * 不能靠复制同形字段成为写能力；持久层仍必须逐字段重验数据库中的 permit/consume/fence 事实。
 */
export class ArtifactExecutionAuthorization {
  readonly permitId: string;
  readonly scope: ExecutionScope;
  readonly runClaimToken: string;
  readonly runClaimEpoch: number;
  readonly workspaceRootRunId: RunId;
  readonly workspaceLeaseEpoch: number;
  readonly attemptVersion: number;
  readonly effect: "tool_execution";
  readonly callId: string;
  readonly toolName: string;
  readonly argsDigest: Sha256Digest;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly consumedAt: IsoTimestamp;
  readonly consumedAtMonotonicMs: number;
  readonly maxContinuationDelayMs: number;

  private constructor(authorization: ConsumedExternalEffectAuthorization) {
    const permit = authorization.permit;
    this.permitId = permit.permitId;
    this.scope = Object.freeze({ ...permit.scope });
    this.runClaimToken = permit.runClaimToken;
    this.runClaimEpoch = permit.runClaimEpoch;
    this.workspaceRootRunId = permit.workspaceRootRunId;
    this.workspaceLeaseEpoch = permit.workspaceLeaseEpoch;
    this.attemptVersion = permit.attemptVersion;
    this.effect = "tool_execution";
    this.callId = permit.callId;
    this.toolName = permit.toolName;
    this.argsDigest = permit.argsDigest;
    this.issuedAt = permit.issuedAt;
    this.expiresAt = permit.expiresAt;
    this.consumedAt = authorization.consumedAt;
    this.consumedAtMonotonicMs = authorization.consumedAtMonotonicMs;
    this.maxContinuationDelayMs = authorization.maxContinuationDelayMs;
    Object.freeze(this);
    issuedAuthorizations.add(this);
  }

  static fromConsumed(
    authorization: ConsumedExternalEffectAuthorization,
    clock: MonotonicClockPort = systemMonotonicClock,
  ): ArtifactExecutionAuthorization {
    assertConsumedAuthorizationShape(authorization);
    assertContinuationWindow(authorization, clock);
    return new ArtifactExecutionAuthorization(authorization);
  }
}

export function assertArtifactExecutionAuthorization(
  authorization: ArtifactExecutionAuthorization,
  expected: { readonly toolName: string; readonly argsDigest: Sha256Digest },
  clock: MonotonicClockPort = systemMonotonicClock,
): void {
  if (
    !issuedAuthorizations.has(authorization) ||
    authorization.effect !== "tool_execution" ||
    authorization.toolName !== expected.toolName ||
    authorization.argsDigest !== expected.argsDigest ||
    authorization.workspaceRootRunId !== authorization.scope.rootRunId ||
    !validScope(authorization.scope) ||
    !nonEmpty(authorization.permitId) ||
    !nonEmpty(authorization.callId) ||
    !nonEmpty(authorization.runClaimToken) ||
    !nonNegativeInteger(authorization.runClaimEpoch) ||
    !nonNegativeInteger(authorization.workspaceLeaseEpoch) ||
    !nonNegativeInteger(authorization.attemptVersion) ||
    !Number.isFinite(authorization.consumedAtMonotonicMs) ||
    authorization.consumedAtMonotonicMs < 0 ||
    !Number.isFinite(authorization.maxContinuationDelayMs) ||
    authorization.maxContinuationDelayMs <= 0 ||
    !validAuthorizationTimeline(
      authorization.issuedAt,
      authorization.consumedAt,
      authorization.expiresAt,
    )
  ) {
    throw invalidAuthorization();
  }
  assertContinuationWindow(authorization, clock);
}

function assertContinuationWindow(
  authorization: Pick<
    ConsumedExternalEffectAuthorization,
    "consumedAtMonotonicMs" | "maxContinuationDelayMs"
  >,
  clock: MonotonicClockPort,
): void {
  const now = clock.now();
  const elapsed = now - authorization.consumedAtMonotonicMs;
  // 等于上限时许可已经失效；负 elapsed 表示时钟来源/进程边界不连续，必须 fail-closed。
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed >= authorization.maxContinuationDelayMs
  ) {
    throw invalidAuthorization();
  }
}

function assertConsumedAuthorizationShape(
  authorization: ConsumedExternalEffectAuthorization,
): void {
  const permit = authorization.permit;
  if (
    permit.effect !== "tool_execution" ||
    permit.workspaceRootRunId !== permit.scope.rootRunId ||
    !validScope(permit.scope) ||
    !nonEmpty(permit.permitId) ||
    !nonEmpty(permit.callId) ||
    !nonEmpty(permit.toolName) ||
    !nonEmpty(permit.runClaimToken) ||
    !/^[a-f0-9]{64}$/u.test(permit.argsDigest) ||
    !nonNegativeInteger(permit.runClaimEpoch) ||
    !nonNegativeInteger(permit.workspaceLeaseEpoch) ||
    !nonNegativeInteger(permit.attemptVersion) ||
    !Number.isFinite(authorization.consumedAtMonotonicMs) ||
    authorization.consumedAtMonotonicMs < 0 ||
    !Number.isFinite(authorization.maxContinuationDelayMs) ||
    authorization.maxContinuationDelayMs <= 0 ||
    !validAuthorizationTimeline(permit.issuedAt, authorization.consumedAt, permit.expiresAt)
  ) {
    throw invalidAuthorization();
  }
}

function nonEmpty(value: string): boolean {
  return value.trim().length > 0 && value.length <= 256;
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validScope(scope: ExecutionScope): boolean {
  return (
    validDomainId(scope.tenantId) &&
    validDomainId(scope.threadId) &&
    validDomainId(scope.runId) &&
    validDomainId(scope.rootRunId) &&
    validDomainId(scope.workspaceId) &&
    (scope.baseRevisionId === undefined || validDomainId(scope.baseRevisionId))
  );
}

function validDomainId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(value);
}

function validAuthorizationTimeline(
  issuedAt: IsoTimestamp,
  consumedAt: IsoTimestamp,
  expiresAt: IsoTimestamp,
): boolean {
  const issued = Date.parse(issuedAt);
  const consumed = Date.parse(consumedAt);
  const expires = Date.parse(expiresAt);
  return (
    Number.isFinite(issued) &&
    Number.isFinite(consumed) &&
    Number.isFinite(expires) &&
    issued <= consumed &&
    consumed <= expires
  );
}

function invalidAuthorization(): ArtifactDeliveryError {
  return artifactError("ARTIFACT_NOT_AUTHORIZED", "Artifact 写入授权无效或已失配");
}
