import type {
  ControlledToolReceiptSource,
  ToolObservationPolicy,
} from "@cube-runtime/context-policy";
import type { RolloutCompatibilityIdentity } from "@cube-runtime/domain";
import {
  type BlobStore,
  createDurableTraceBlobPersistence,
  PgToolObservationRolloutAdapter,
  type PgRuntimeRolloutRepository,
  type TraceBlobCommitRepository,
  type TrustedRolloutContext,
} from "@cube-runtime/persistence";
import {
  type ControlledRolloutProjection,
  projectLoadedRuntimeRecovery,
} from "@cube-runtime/pi-adapter";
import { createDurableObservationRecorderFactory } from "./pi-session-factory.js";
import type { AgentSessionFactoryPort } from "./ports.js";

type SessionInput = Parameters<AgentSessionFactoryPort["create"]>[0];

export interface PreparedPgObservationSession {
  readonly prepare: (
    session: SessionInput,
    compatibility: RolloutCompatibilityIdentity,
  ) => Promise<ControlledRolloutProjection | undefined>;
  readonly createRecorder: (
    session: SessionInput,
    outputs: ControlledToolReceiptSource,
  ) => ReturnType<ReturnType<typeof createDurableObservationRecorderFactory>>;
}

/**
 * PG/S3 生产 Session 装配。调用方不能注入 user/context：prepare 只携带 RunWorker 当前双栅栏，
 * Repository 在同一事务从 claim、Thread creator 与 active Membership 推导 actor 并幂等开流。
 */
export function createPgDurableObservationSession(input: {
  readonly blobRepository: TraceBlobCommitRepository;
  readonly blobs: BlobStore;
  readonly rolloutRepository: PgRuntimeRolloutRepository;
  readonly policy: ToolObservationPolicy;
}): PreparedPgObservationSession {
  const prepared = new WeakMap<SessionInput, TrustedRolloutContext>();
  const createRecorder = createDurableObservationRecorderFactory((session) => {
    const context = prepared.get(session);
    if (context === undefined) throw new Error("PG Tool Observation Session 尚未从 claim 准备");
    return {
      binding: {
        scope: session.scope,
        attemptId: session.attemptId,
        agentThreadId: context.scope.agentThreadId,
      },
      traces: createDurableTraceBlobPersistence(input.blobRepository, input.blobs),
      rollout: new PgToolObservationRolloutAdapter(input.rolloutRepository, context),
      policy: input.policy,
    };
  });
  return Object.freeze({
    async prepare(session: SessionInput, compatibility: RolloutCompatibilityIdentity) {
      if (
        session.fence.scope.tenantId !== session.scope.tenantId ||
        session.fence.scope.threadId !== session.scope.threadId ||
        session.fence.scope.runId !== session.scope.runId ||
        session.fence.scope.rootRunId !== session.scope.rootRunId ||
        session.fence.scope.workspaceId !== session.scope.workspaceId ||
        session.fence.scope.baseRevisionId !== session.scope.baseRevisionId ||
        session.fence.workspaceLease.rootRunId !== session.scope.rootRunId ||
        session.attemptId.trim().length === 0
      ) {
        throw new Error("PG Tool Observation fence 与当前 Session 不匹配");
      }
      const opened =
        session.agent === undefined
          ? await input.rolloutRepository.openRootStreamFromClaim({
              fence: session.fence,
              attemptId: session.attemptId,
              compatibility,
            })
          : await input.rolloutRepository.openAgentStreamFromClaim({
              fence: session.fence,
              attemptId: session.attemptId,
              compatibility,
              agentThreadId: session.agent.agentThreadId,
              agentKind: session.agent.agentKind,
            });
      if (opened.outcome !== "ready") throw new Error("PG Tool Observation root stream 未就绪");
      prepared.set(session, opened.context);
      const loaded = await input.rolloutRepository.loadRecovery({
        context: opened.context,
        compatibility,
      });
      if (loaded.outcome !== "loaded") throw new Error("PG Tool Observation 恢复身份不兼容");
      if (loaded.checkpoint === undefined && loaded.tail.length === 0) return undefined;
      const projected = projectLoadedRuntimeRecovery(loaded);
      if (projected.outcome !== "ready") {
        throw new Error("PG Tool Observation 存在未协调 Tool call");
      }
      return projected.projection;
    },
    createRecorder,
  });
}
