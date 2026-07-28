import type { ToolObservationPolicy } from "@cube-runtime/context-policy";
import {
  type BlobStore,
  createDurableTraceBlobPersistence,
  PgToolObservationRolloutAdapter,
  type PgRuntimeRolloutRepository,
  type TraceBlobCommitRepository,
  type TrustedRolloutContext,
} from "@cube-runtime/persistence";
import { createDurableObservationRecorderFactory } from "./pi-session-factory.js";
import type { AgentSessionFactoryPort } from "./ports.js";

type SessionInput = Parameters<AgentSessionFactoryPort["create"]>[0];

/**
 * PG/S3 生产装配的唯一受审入口。TrustedRolloutContext 必须来自服务端 claim/身份事实；
 * 本函数在构造 adapter 前逐项绑定当前 Session，避免把另一 Attempt 的 context 错装进闭包。
 */
export function createPgDurableObservationRecorderFactory(input: {
  readonly blobRepository: TraceBlobCommitRepository;
  readonly blobs: BlobStore;
  readonly rolloutRepository: PgRuntimeRolloutRepository;
  readonly contextForSession: (session: SessionInput) => TrustedRolloutContext;
  readonly policy: ToolObservationPolicy;
}) {
  return createDurableObservationRecorderFactory((session) => {
    const context = input.contextForSession(session);
    const scope = context.scope;
    if (
      scope.tenantId !== session.scope.tenantId ||
      scope.threadId !== session.scope.threadId ||
      scope.runId !== session.scope.runId ||
      scope.attemptId !== session.attemptId
    ) {
      throw new Error("PG Tool Observation context 与当前 Session 不匹配");
    }
    return {
      binding: {
        scope: session.scope,
        attemptId: session.attemptId,
        agentThreadId: scope.agentThreadId,
      },
      traces: createDurableTraceBlobPersistence(input.blobRepository, input.blobs),
      rollout: new PgToolObservationRolloutAdapter(input.rolloutRepository, context),
      policy: input.policy,
    };
  });
}
