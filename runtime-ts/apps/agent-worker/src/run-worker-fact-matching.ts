// 持久事实回读比对：变更、检查、快照与回执必须与本次执行身份完全一致才被接受。
import type { Run, Workspace } from "@hoox/domain";
import {
  outboxPayloadDigest,
  rolloutProjectionDigest,
  sandboxCleanupIdentityDigest,
  workspaceChangeDigest,
} from "./mutation-protocol.js";
import type {
  ExecutionAttemptSnapshot,
  ExecutionFence,
  ExecutionPersistencePort,
  ExecutionScope,
  ExternalEffectCall,
  ExternalEffectPermit,
  RuntimeMutation,
  RuntimeMutationResult,
  RuntimeOutboxReceiptV1,
} from "./ports.js";
import type { AppliedMutation, ExecutionContext } from "./run-worker-context.js";

export function isApplied(result: RuntimeMutationResult): result is AppliedMutation {
  return result.outcome === "applied" || result.outcome === "already_applied";
}

export function sameScope(left: ExecutionScope, right: ExecutionScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.threadId === right.threadId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.workspaceId === right.workspaceId &&
    left.baseRevisionId === right.baseRevisionId
  );
}

export function entitiesMatch(scope: ExecutionScope, run: Run, workspace: Workspace): boolean {
  return (
    run.id === scope.runId &&
    run.tenantId === scope.tenantId &&
    run.threadId === scope.threadId &&
    workspace.id === scope.workspaceId &&
    workspace.tenantId === scope.tenantId &&
    workspace.threadId === scope.threadId
  );
}

export function snapshotMatches(
  scope: ExecutionScope,
  fence: ExecutionFence,
  run: Run,
  workspace: Workspace,
  attempt: ExecutionAttemptSnapshot,
): boolean {
  return (
    sameScope(scope, fence.scope) &&
    entitiesMatch(scope, run, workspace) &&
    run.status === "running" &&
    attempt.status === "claimed" &&
    attempt.stage === "claimed" &&
    attempt.version === 0 &&
    fence.workspaceLease.rootRunId === scope.rootRunId &&
    workspace.writerLease?.rootRunId === scope.rootRunId &&
    workspace.writerLease.epoch === fence.workspaceLease.epoch &&
    workspace.writerLease.expiresAt === fence.workspaceLease.expiresAt &&
    workspace.currentRevisionId === attempt.currentRevisionId
  );
}

export function inspectionMatches(
  context: ExecutionContext,
  inspected: Extract<
    Awaited<ReturnType<ExecutionPersistencePort["inspectAndRenew"]>>,
    { outcome: "active" }
  >,
): boolean {
  return (
    sameScope(context.scope, inspected.fence.scope) &&
    entitiesMatch(context.scope, inspected.run, inspected.workspace) &&
    inspected.run.status === "running" &&
    inspected.fence.runClaim.token === context.fence.runClaim.token &&
    inspected.fence.runClaim.epoch === context.fence.runClaim.epoch &&
    inspected.fence.workspaceLease.rootRunId === context.scope.rootRunId &&
    inspected.fence.workspaceLease.epoch === context.fence.workspaceLease.epoch &&
    Date.parse(inspected.fence.runClaim.expiresAt) > Date.parse(context.fence.runClaim.expiresAt) &&
    Date.parse(inspected.fence.workspaceLease.expiresAt) >
      Date.parse(context.fence.workspaceLease.expiresAt) &&
    inspected.workspace.writerLease?.rootRunId === context.scope.rootRunId &&
    inspected.workspace.writerLease.epoch === inspected.fence.workspaceLease.epoch &&
    inspected.workspace.writerLease.expiresAt === inspected.fence.workspaceLease.expiresAt &&
    inspected.workspace.currentRevisionId === context.currentRevisionId
  );
}

export function acceptInspection(
  context: ExecutionContext,
  inspected: Extract<
    Awaited<ReturnType<ExecutionPersistencePort["inspectAndRenew"]>>,
    { outcome: "active" }
  >,
): void {
  context.fence = inspected.fence;
  context.databaseNow = inspected.databaseNow;
  context.run = inspected.run;
  context.workspace = inspected.workspace;
}

export function appliedSnapshotMatches(
  context: ExecutionContext,
  result: AppliedMutation,
  command: Omit<
    RuntimeMutation,
    | "schemaVersion"
    | "commandDigest"
    | "fence"
    | "expectedAttemptVersion"
    | "expectedProjectionVersion"
  >,
): boolean {
  const expectedStage = command.nextStage ?? context.actualCommittedStage;
  const expectedStatus = command.nextAttemptStatus ?? context.actualAttemptStatus;
  const expectedRevision = command.workspaceChange?.revisionId ?? context.currentRevisionId;
  return (
    sameScope(context.scope, result.scope) &&
    entitiesMatch(context.scope, result.run, result.workspace) &&
    result.attempt.attemptId === context.attemptId &&
    result.attempt.version === result.attemptVersion &&
    result.attempt.nextEventSequence === result.nextEventSequence &&
    result.nextEventSequence === context.nextEventSequence + command.events.length &&
    result.attempt.stage === expectedStage &&
    result.attempt.status === expectedStatus &&
    result.attempt.projectionVersion ===
      (command.rolloutProjection === undefined
        ? context.projectionVersion
        : context.projectionVersion + 1) &&
    result.attempt.currentRevisionId === expectedRevision &&
    (command.nextRunStatus === undefined || result.run.status === command.nextRunStatus) &&
    result.workspace.currentRevisionId === result.attempt.currentRevisionId
  );
}

export function receiptMatches(
  context: ExecutionContext,
  result: AppliedMutation,
  command: RuntimeMutation,
): boolean {
  const receipt = result.receipt;
  const outboxMatches =
    receipt.outbox.length === command.outbox.length &&
    receipt.outbox.every((item, index) => {
      const expected = command.outbox[index];
      if (
        expected === undefined ||
        item.kind !== expected.kind ||
        item.idempotencyKey !== expected.idempotencyKey ||
        item.state !== expected.state
      ) {
        return false;
      }
      if (expected.kind !== "sandbox_cleanup") {
        return item.payloadDigest === outboxPayloadDigest(expected);
      }
      if (item.kind !== "sandbox_cleanup") return false;
      const previous = context.cleanupFacts.get(expected.idempotencyKey);
      const expectedArmedAt = previous?.armedAt ?? result.databaseNow;
      const expectedDisposition =
        "disposition" in expected.payload ? expected.payload.disposition : undefined;
      return (
        item.armed === true &&
        item.armedAt === expectedArmedAt &&
        item.identity.registryId === expected.payload.registryId &&
        item.identity.providerSandboxId === expected.payload.providerSandboxId &&
        item.identityDigest === sandboxCleanupIdentityDigest(expected) &&
        item.identityDigest === (previous?.identityDigest ?? item.identityDigest) &&
        (previous?.disposition === undefined || item.disposition === previous.disposition) &&
        item.disposition === expectedDisposition &&
        item.payloadDigest === outboxPayloadDigest(expected, expectedArmedAt)
      );
    });
  const projectionMatches =
    command.rolloutProjection === undefined
      ? receipt.projection === undefined
      : receipt.projection?.schemaVersion === 1 &&
        receipt.projection.previousVersion === context.projectionVersion &&
        receipt.projection.version === context.projectionVersion + 1 &&
        receipt.projection.digest === rolloutProjectionDigest(command.rolloutProjection);
  const workspaceMatches =
    command.workspaceChange === undefined
      ? receipt.workspace === undefined
      : receipt.workspace?.changeDigest === workspaceChangeDigest(command.workspaceChange) &&
        receipt.workspace.previousHead === context.currentRevisionId &&
        receipt.workspace.currentHead === command.workspaceChange.revisionId;
  const expectedContextEntries =
    command.threadSteer === undefined ? command.threadContextAppend?.entries.length : 1;
  const threadContextMatches =
    expectedContextEntries === undefined
      ? receipt.threadContext === undefined
      : receipt.threadContext?.schemaVersion === 1 &&
        receipt.threadContext.entryCount === expectedContextEntries &&
        Number.isSafeInteger(receipt.threadContext.firstSequence) &&
        receipt.threadContext.firstSequence > 0 &&
        receipt.threadContext.lastSequence ===
          receipt.threadContext.firstSequence + expectedContextEntries - 1;
  const threadSteerMatches =
    command.threadSteer === undefined
      ? receipt.threadSteer === undefined
      : receipt.threadSteer?.receiptId === command.threadSteer.receiptId &&
        receipt.threadSteer.targetTurnId === command.threadSteer.targetTurnId &&
        receipt.threadSteer.bodyDigest === command.threadSteer.bodyDigest &&
        receipt.threadSteer.appliedContextSequence === receipt.threadContext?.firstSequence;
  const effectInvocationMatches =
    command.effectInvocation === undefined
      ? receipt.effectInvocation === undefined
      : receipt.effectInvocation?.callId === command.effectInvocation.callId &&
        receipt.effectInvocation.toolName === command.effectInvocation.toolName;
  const threadSandboxMatches =
    command.threadSandboxTerminal === undefined
      ? receipt.threadSandbox === undefined
      : receipt.threadSandbox?.schemaVersion === 1 &&
        receipt.threadSandbox.sessionId === command.threadSandboxTerminal.sessionId &&
        receipt.threadSandbox.generation === command.threadSandboxTerminal.generation &&
        (context.sandboxIdleAction !== "kill" ||
          (receipt.threadSandbox.outcome === "effect_pending" &&
            receipt.threadSandbox.effectKind === "terminate")) &&
        (receipt.threadSandbox.outcome === "effect_pending"
          ? (receipt.threadSandbox.effectKind === "pause" ||
              receipt.threadSandbox.effectKind === "terminate") &&
            receipt.threadSandbox.effectId.trim().length > 0
          : receipt.threadSandbox.nextRunId.trim().length > 0);
  return (
    receipt.schemaVersion === 1 &&
    receipt.idempotencyKey === command.idempotencyKey &&
    receipt.commandDigest === command.commandDigest &&
    receipt.previousAttemptVersion === context.attemptVersion &&
    receipt.attemptVersion === context.attemptVersion + 1 &&
    result.attemptVersion === context.attemptVersion + 1 &&
    result.attemptVersion === receipt.attemptVersion &&
    receipt.eventSequenceStart === context.nextEventSequence &&
    receipt.eventSequenceEnd === context.nextEventSequence + command.events.length &&
    result.nextEventSequence === receipt.eventSequenceEnd &&
    outboxMatches &&
    effectInvocationMatches &&
    projectionMatches &&
    workspaceMatches &&
    threadContextMatches &&
    threadSteerMatches &&
    threadSandboxMatches
  );
}

export function acceptOutboxReceipts(
  context: ExecutionContext,
  receipts: readonly RuntimeOutboxReceiptV1[],
): void {
  for (const receipt of receipts) {
    if (receipt.kind !== "sandbox_cleanup") continue;
    context.cleanupFacts.set(receipt.idempotencyKey, {
      armedAt: receipt.armedAt,
      identityDigest: receipt.identityDigest,
      ...(receipt.disposition === undefined ? {} : { disposition: receipt.disposition }),
    });
  }
}

export function permitMatches(
  context: ExecutionContext,
  permit: ExternalEffectPermit,
  effect: ExternalEffectPermit["effect"],
  call: ExternalEffectCall,
): boolean {
  return (
    permit.effect === effect &&
    permit.callId === call.callId &&
    permit.toolName === call.toolName &&
    permit.argsDigest === call.argsDigest &&
    sameScope(permit.scope, context.scope) &&
    permit.runClaimToken === context.fence.runClaim.token &&
    permit.runClaimEpoch === context.fence.runClaim.epoch &&
    permit.workspaceRootRunId === context.fence.workspaceLease.rootRunId &&
    permit.workspaceLeaseEpoch === context.fence.workspaceLease.epoch &&
    permit.attemptVersion === context.attemptVersion &&
    Date.parse(permit.issuedAt) < Date.parse(permit.expiresAt) &&
    Date.parse(permit.expiresAt) > Date.parse(context.databaseNow)
  );
}
