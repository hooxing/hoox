import type {
  AgentThreadId,
  IsoTimestamp,
  RunId,
  Sha256Digest,
  TenantId,
  ThreadId,
} from "./ids.js";

/** Runtime 自有 Rollout 的身份；首版只开放 root，但保留 Agent Thread 维度避免未来迁移事实。 */
export interface RolloutScope {
  readonly tenantId: TenantId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly attemptId: string;
  readonly agentThreadId: AgentThreadId;
}

export type RuntimeRolloutEntryKind =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "waiting"
  | "sandbox_recovery"
  | "terminal";

export interface RolloutCompatibilityIdentity {
  readonly modelId: string;
  readonly modelCompatibilityHash: Sha256Digest;
  readonly promptPolicyHash: Sha256Digest;
  readonly toolSchemaHash: Sha256Digest;
  readonly skillManifestHash: Sha256Digest;
}

export interface RolloutBlobReference {
  readonly referenceId: string;
  readonly sha256: Sha256Digest;
  readonly size: number;
}

/** body 是可进入模型窗口的有界摘要；完整大输出只能通过稳定 trace Blob 引用保存。 */
export interface RuntimeRolloutEntry {
  readonly sequence: number;
  readonly kind: RuntimeRolloutEntryKind;
  readonly toolCallId?: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly bodyDigest: Sha256Digest;
  readonly isTruncated: boolean;
  readonly blob?: RolloutBlobReference;
  readonly occurredAt: IsoTimestamp;
}

export interface RuntimeRolloutCheckpoint {
  readonly checkpointId: string;
  readonly windowStartSequence: number;
  readonly throughSequence: number;
  readonly projection: Readonly<Record<string, unknown>>;
  readonly projectionDigest: Sha256Digest;
  /** 仅描述模型投影中被替换的区间；原始 RuntimeRolloutEntry 永不删除。 */
  readonly replacementHistory: readonly Readonly<Record<string, unknown>>[];
  readonly createdAt: IsoTimestamp;
}
