import type { IsoTimestamp, RunId, Sha256Digest } from "@hoox/domain";
import type { ConsumedExternalEffectAuthorization, ExecutionScope } from "@hoox/run-contracts";
import { type ArtifactDeliveryError, artifactError } from "./errors.js";

const constructionToken = Object.freeze({ kind: "artifact-execution-authorization" });

export interface MonotonicClockPort {
  now(): number;
}

export const systemMonotonicClock: MonotonicClockPort = Object.freeze({
  now: () => performance.now(),
});

export interface ArtifactExecutionAuthorizationExpectation {
  readonly toolName: string;
  readonly argsDigest: Sha256Digest;
  /** Router 必须校验本 Session 的不可变 Attempt 身份；版本则由每次动态消费的 permit 携带。 */
  readonly attemptId?: string;
  readonly scope?: ExecutionScope;
}

export interface ArtifactExecutionAuthorizationIssuerPort {
  issue(input: {
    readonly consumed: ConsumedExternalEffectAuthorization;
    readonly attemptId: string;
  }): ArtifactExecutionAuthorization;
}

export interface ArtifactExecutionAuthorizationVerifierPort {
  assert(
    authorization: ArtifactExecutionAuthorization,
    expected: ArtifactExecutionAuthorizationExpectation,
  ): void;
}

export interface ArtifactExecutionAuthorizationAuthority {
  readonly issuer: ArtifactExecutionAuthorizationIssuerPort;
  readonly verifier: ArtifactExecutionAuthorizationVerifierPort;
}

/**
 * 这是进程内能力对象，不是可反序列化 DTO。运行时构造令牌阻断 `new`、`Reflect.construct`、
 * `as any`、JSON 和原型伪造；每个 authority 还使用独立 WeakSet，其他 authority 签发的实例
 * 也不能通过当前服务的 verifier。持久层仍必须重验 permit/consume/fence 数据库事实。
 */
export class ArtifactExecutionAuthorization {
  readonly permitId: string;
  readonly attemptId: string;
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

  private constructor(
    token: object,
    authorization: ConsumedExternalEffectAuthorization,
    attemptId: string,
  ) {
    if (token !== constructionToken) throw invalidAuthorization();
    const permit = authorization.permit;
    this.permitId = permit.permitId;
    this.attemptId = attemptId;
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
  }
}

type PrivateAuthorizationConstructor = new (
  token: object,
  authorization: ConsumedExternalEffectAuthorization,
  attemptId: string,
) => ArtifactExecutionAuthorization;

// 通过模块词法绑定捕获真实 [[Construct]]；issuer 不读取导出 class 上可被补写的 static 属性。
const PrivateAuthorization =
  ArtifactExecutionAuthorization as unknown as PrivateAuthorizationConstructor;
Object.freeze(ArtifactExecutionAuthorization.prototype);
Object.freeze(ArtifactExecutionAuthorization);

function constructAuthorization(
  authorization: ConsumedExternalEffectAuthorization,
  attemptId: string,
): ArtifactExecutionAuthorization {
  return new PrivateAuthorization(constructionToken, authorization, attemptId);
}

/**
 * 生产装配只创建一次 authority：issuer 仅交给 Worker，verifier 交给 Router、ArtifactService
 * 及需要验证该能力的持久适配器。模型与 HTTP 层不得获得 issuer。
 */
export function createArtifactExecutionAuthorizationAuthority(
  clock: MonotonicClockPort = systemMonotonicClock,
): ArtifactExecutionAuthorizationAuthority {
  const issued = new WeakSet<object>();
  const issuer: ArtifactExecutionAuthorizationIssuerPort = Object.freeze({
    issue(input: {
      readonly consumed: ConsumedExternalEffectAuthorization;
      readonly attemptId: string;
    }) {
      assertConsumedAuthorizationShape(input.consumed);
      if (!validOpaqueId(input.attemptId)) throw invalidAuthorization();
      assertContinuationWindow(input.consumed, clock);
      const authorization = constructAuthorization(input.consumed, input.attemptId);
      issued.add(authorization);
      return authorization;
    },
  });
  const verifier: ArtifactExecutionAuthorizationVerifierPort = Object.freeze({
    assert(
      authorization: ArtifactExecutionAuthorization,
      expected: ArtifactExecutionAuthorizationExpectation,
    ) {
      if (
        !issued.has(authorization) ||
        authorization.effect !== "tool_execution" ||
        authorization.toolName !== expected.toolName ||
        authorization.argsDigest !== expected.argsDigest ||
        (expected.attemptId !== undefined && authorization.attemptId !== expected.attemptId) ||
        (expected.scope !== undefined && !sameScope(authorization.scope, expected.scope)) ||
        authorization.workspaceRootRunId !== authorization.scope.rootRunId ||
        !validScope(authorization.scope) ||
        !validOpaqueId(authorization.attemptId) ||
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
    },
  });
  return Object.freeze({ issuer, verifier });
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

function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
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

function validOpaqueId(value: string): boolean {
  return value.length >= 3 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_./:-]*$/u.test(value);
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
