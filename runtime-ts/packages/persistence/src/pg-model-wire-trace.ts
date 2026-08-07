import { createHash, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { BlobStore, StableBlobGcPort, StableBlobRef } from "./blob-store.js";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import {
  TransactionCommitUnknownError,
  withTenantTransaction,
  type Pool,
  type PoolClient,
} from "./postgres.js";
import {
  createDurableTraceBlobPersistence,
  DurableTraceBlobPersistenceAdapter,
  type TraceBlobCommitRepository,
} from "./trace-blob-persistence-adapter.js";

export interface ModelWireTraceContext {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly agentThreadId?: string;
  readonly agentTurnId?: string;
}

export interface ModelWireTracePort {
  persist(input: ModelWireTracePersistInput): Promise<void>;
  captureFailed(input: ModelWireTraceCaptureFailedInput): Promise<void>;
}

export interface ModelWireTracePersistInput {
  readonly context: ModelWireTraceContext;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: "request" | "response";
  readonly body: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly status: "complete" | "truncated" | "aborted" | "failed";
  readonly httpStatus?: number;
}

export interface ModelWireTraceCaptureFailedInput {
  readonly context: ModelWireTraceContext;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: "request" | "response";
  readonly code: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE";
  readonly httpStatus?: number;
}

export interface PgModelWireTraceRepositoryOptions {
  /** 故障测试可在真实事务提交后模拟客户端未收到响应；实现仍只按原命令读回。 */
  readonly afterCommit?: (
    operation: "prepare" | "finalize" | "capture_failed",
  ) => void | Promise<void>;
  readonly processingLeaseSeconds?: number;
  /** 可选同进程快速补偿；未提供时迟到引用仍先写 durable cleanup item，由 consumer.resumePending 回收。 */
  readonly lateReferenceGc?: StableBlobGcPort;
  /** 仅供故障测试在迟到引用补偿事务前模拟进程退出。 */
  readonly beforeLateReferenceCompensation?: () => void | Promise<void>;
  readonly beforeBlobPersistence?: () => void | Promise<void>;
  readonly beforeFinalizeStored?: () => void | Promise<void>;
}

export interface ModelWireTraceCleanupCommand {
  readonly tenantId: string;
  readonly commandId: string;
  readonly expiresBefore: Date;
  readonly batchSize: number;
}

export interface ModelWireTraceCleanupResult {
  readonly outcome: "completed" | "replayed";
  readonly deletedCount: number;
}

export interface ModelWireTraceCleanupResumeInput {
  readonly tenantId: string;
  readonly batchSize: number;
}

export interface PgModelWireTraceCleanupRepositoryOptions {
  readonly afterCommit?: (operation: "cleanup") => void | Promise<void>;
  readonly beforeCompletionTransition?: () => void | Promise<void>;
  /** 提供后，cleanup 会先从 durable commit snapshot 收敛/放弃过期 in-flight staging。 */
  readonly inFlightRecovery?: {
    readonly commits: TraceBlobCommitRepository;
    readonly blobs: BlobStore;
  };
}

type PersistenceStatus =
  | "pending"
  | "stored"
  | "unknown"
  | "conflict"
  | "unavailable"
  | "not_captured";

interface TraceCommandIdentity {
  readonly tenantId: string;
  readonly attemptId: string;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: "request" | "response";
}

interface PreparedCommand extends TraceCommandIdentity {
  readonly commandDigest: string;
  readonly blobOperationId: string;
  readonly persistenceStatus: PersistenceStatus;
  readonly processingToken?: string;
  readonly processingLeaseExpiresAt?: Date;
  readonly cleanupCommandId?: string;
}

interface CapturedCommand extends TraceCommandIdentity {
  readonly context: ModelWireTraceContext;
  readonly commandDigest: string;
  readonly blobOperationId: string;
  readonly captureStatus: ModelWireTracePersistInput["status"];
  readonly sha256: string;
  readonly size: number;
  readonly httpStatus?: number;
}

/**
 * 模型报文索引先提交不可变命令意图，再推进 Blob 状态机。这样 Blob 已落而最终索引提交失败时，
 * 同命令重放与到期清理都有持久恢复锚点，不会产生永远不可发现的引用。
 */
export class PgModelWireTraceRepository implements ModelWireTracePort {
  readonly #processingLeaseSeconds: number;

  constructor(
    private readonly pool: Pool,
    private readonly commits: TraceBlobCommitRepository,
    private readonly blobs: BlobStore,
    private readonly retentionDays: number,
    private readonly options: PgModelWireTraceRepositoryOptions = {},
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
      throw new TypeError("模型网络诊断保留天数无效");
    const lease = options.processingLeaseSeconds ?? 300;
    if (!Number.isSafeInteger(lease) || lease < 1 || lease > 3_600)
      throw new TypeError("模型网络诊断 processing lease 无效");
    this.#processingLeaseSeconds = lease;
  }

  async persist(input: ModelWireTracePersistInput): Promise<void> {
    assertPersistInput(input);
    const command = capturedCommand(input);
    const processingToken = randomUUID();
    const prepared = await this.prepare(command, processingToken);
    if (
      prepared === "expired" ||
      prepared === "busy" ||
      prepared.persistenceStatus === "stored" ||
      prepared.persistenceStatus === "conflict"
    ) {
      return;
    }
    await this.options.beforeBlobPersistence?.();
    const traces = createDurableTraceBlobPersistence(this.commits, this.blobs);
    const result = await traces.persistTrace({
      tenantId: input.context.tenantId,
      idempotencyKey: wireOperationKey(command),
      body: input.body,
      sha256: input.sha256,
    });
    if (result.outcome === "persisted" || result.outcome === "replayed") {
      if (
        result.blob.tenantId !== command.tenantId ||
        result.blob.purpose !== "trace" ||
        result.blob.sha256 !== command.sha256 ||
        result.blob.size !== command.size
      ) {
        throw new PersistenceError("CONSTRAINT_VIOLATION", "Trace Blob 返回身份与命令不一致");
      }
      await this.options.beforeFinalizeStored?.();
      await this.finalizeStored(command, processingToken, result);
      return;
    }
    await this.finalizeStatus(command, processingToken, result.outcome);
  }

  async captureFailed(input: ModelWireTraceCaptureFailedInput): Promise<void> {
    assertCaptureFailedInput(input);
    const command = failedCommand(input);
    let committed = false;
    try {
      await withTenantTransaction(this.pool, input.context, async (client) => {
        const replay = await readPrepared(client, command);
        if (replay !== undefined) {
          assertSameCommand(replay, command.commandDigest);
          return;
        }
        const expiredDigest = await tombstoneDigest(client, command);
        if (expiredDigest !== undefined) {
          if (expiredDigest !== command.commandDigest) throw commandConflict();
          return;
        }
        const inserted = await client.query(
          `INSERT INTO model_wire_trace_records(
             tenant_id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
             model_turn,transport_attempt,part,
             command_digest,blob_operation_id,capture_status,capture_error_code,
             persistence_status,http_status,expires_at
           ) SELECT $1,$2,$3,$4,attempt.workspace_id,attempt.root_run_id,$5,$6,$7,$8,$9,$10,$11,
                    'not_captured',$12,clock_timestamp()+make_interval(days=>$13::integer)
               FROM execution_attempts attempt
              WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$4
                AND attempt.run_id=$3 AND attempt.thread_id=$2`,
          [
            input.context.tenantId,
            input.context.threadId,
            input.context.runId,
            input.context.attemptId,
            input.modelTurn,
            input.transportAttempt,
            input.part,
            command.commandDigest,
            command.blobOperationId,
            input.code === "BODY_UNREADABLE" ? "aborted" : "failed",
            input.code,
            input.httpStatus ?? null,
            this.retentionDays,
          ],
        );
        if (inserted.rowCount !== 1)
          throw new PersistenceError("CONFLICT", "模型网络诊断 Attempt 绑定不存在");
      });
      committed = true;
      await this.options.afterCommit?.("capture_failed");
    } catch (error) {
      const replay = await this.readAfterAmbiguousWrite(command, error, committed);
      if (replay === "same" || replay === "expired") return;
      if (replay === "different") throw commandConflict();
      throw mapPersistenceError(error, "保存模型网络诊断捕获失败事实");
    }
  }

  private async prepare(
    command: CapturedCommand,
    processingToken: string,
  ): Promise<PreparedCommand | "expired" | "busy"> {
    let committed = false;
    try {
      const prepared = await withTenantTransaction(
        this.pool,
        { tenantId: command.tenantId },
        async (client) => {
          const existing = await readPrepared(client, command, true);
          if (existing !== undefined) {
            assertSameCommand(existing, command.commandDigest);
            if (existing.cleanupCommandId !== undefined) {
              throw new PersistenceError("UNAVAILABLE", "模型网络诊断命令正在到期清理");
            }
            if (
              existing.persistenceStatus === "stored" ||
              existing.persistenceStatus === "conflict"
            ) {
              return existing;
            }
            if (
              existing.processingToken !== undefined &&
              existing.processingLeaseExpiresAt !== undefined &&
              existing.processingLeaseExpiresAt.getTime() > Date.now()
            ) {
              return "busy" as const;
            }
            const claimed = await client.query(
              `UPDATE model_wire_trace_records
                  SET processing_token=$6::uuid,
                      processing_lease_expires_at=clock_timestamp()+make_interval(secs=>$7::double precision),
                      updated_at=clock_timestamp()
                WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=$3
                  AND transport_attempt=$4 AND part=$5 AND cleanup_command_id IS NULL`,
              [
                command.tenantId,
                command.attemptId,
                command.modelTurn,
                command.transportAttempt,
                command.part,
                processingToken,
                this.#processingLeaseSeconds,
              ],
            );
            if (claimed.rowCount !== 1) throw new Error("模型网络诊断 processing lease 获取失败");
            return { ...existing, processingToken };
          }
          const expiredDigest = await tombstoneDigest(client, command);
          if (expiredDigest !== undefined) {
            if (expiredDigest !== command.commandDigest) throw commandConflict();
            return "expired" as const;
          }
          const inserted = await client.query(
            `INSERT INTO model_wire_trace_records(
               tenant_id,thread_id,run_id,attempt_id,workspace_id,root_run_id,
               model_turn,transport_attempt,part,
               command_digest,blob_operation_id,capture_status,persistence_status,sha256,size,
               http_status,processing_token,processing_lease_expires_at,expires_at
             ) SELECT $1,$2,$3,$4,attempt.workspace_id,attempt.root_run_id,$5,$6,$7,$8,$9,$10,
                      'pending',$11,$12,$13,$14::uuid,
                      clock_timestamp()+make_interval(secs=>$15::double precision),
                      clock_timestamp()+make_interval(days=>$16::integer)
                 FROM execution_attempts attempt
                WHERE attempt.tenant_id=$1 AND attempt.attempt_id=$4
                  AND attempt.run_id=$3 AND attempt.thread_id=$2`,
            [
              command.context.tenantId,
              command.context.threadId,
              command.context.runId,
              command.context.attemptId,
              command.modelTurn,
              command.transportAttempt,
              command.part,
              command.commandDigest,
              command.blobOperationId,
              command.captureStatus,
              command.sha256,
              command.size,
              command.httpStatus ?? null,
              processingToken,
              this.#processingLeaseSeconds,
              this.retentionDays,
            ],
          );
          if (inserted.rowCount !== 1)
            throw new PersistenceError("CONFLICT", "模型网络诊断 Attempt 绑定不存在");
          return {
            ...identityOf(command),
            commandDigest: command.commandDigest,
            blobOperationId: command.blobOperationId,
            persistenceStatus: "pending" as const,
            processingToken,
          };
        },
      );
      committed = true;
      await this.options.afterCommit?.("prepare");
      return prepared;
    } catch (error) {
      const replay = await this.readAfterAmbiguousWrite(command, error, committed, true);
      if (replay === "different") throw commandConflict();
      if (replay === "expired") return "expired";
      if (typeof replay === "object") {
        if (
          replay.persistenceStatus === "stored" ||
          replay.persistenceStatus === "conflict" ||
          replay.processingToken === processingToken
        ) {
          return replay;
        }
        return "busy";
      }
      throw mapPersistenceError(error, "准备模型网络诊断命令");
    }
  }

  private async finalizeStored(
    command: CapturedCommand,
    processingToken: string,
    result: {
      readonly referenceId: string;
      readonly blob: {
        readonly incarnationId: string;
        readonly physicalObjectKey: string;
      };
    },
  ): Promise<void> {
    await this.finalize(command, async (client) => {
      const updated = await client.query(
        `UPDATE model_wire_trace_records record
            SET persistence_status='stored',blob_reference_id=reference.reference_id,
                blob_state=reference.state,blob_purpose=reference.purpose,
                blob_lifecycle_id=reference.lifecycle_id,
                blob_incarnation_id=reference.incarnation_id,
                physical_object_key=reference.physical_object_key,processing_token=NULL,
                processing_lease_expires_at=NULL,updated_at=clock_timestamp()
           FROM blob_references reference
          WHERE record.tenant_id=$1 AND record.attempt_id=$2 AND record.model_turn=$3
            AND record.transport_attempt=$4 AND record.part=$5 AND record.command_digest=$6
            AND record.cleanup_command_id IS NULL
            AND record.processing_token=$7::uuid
            AND reference.tenant_id=record.tenant_id AND reference.reference_id=$8
            AND reference.operation_id=record.blob_operation_id AND reference.state='stable'
            AND reference.purpose='trace' AND reference.sha256=record.sha256
            AND reference.size=record.size AND reference.incarnation_id=$9::uuid
            AND reference.physical_object_key=$10
          RETURNING record.command_digest`,
        [
          command.tenantId,
          command.attemptId,
          command.modelTurn,
          command.transportAttempt,
          command.part,
          command.commandDigest,
          processingToken,
          result.referenceId,
          result.blob.incarnationId,
          result.blob.physicalObjectKey,
        ],
      );
      if (updated.rowCount !== 1) {
        const existing = await readPrepared(client, command);
        if (existing === undefined) {
          const expired = await tombstoneDigest(client, command);
          if (expired === command.commandDigest) return;
          throw new Error("模型网络诊断命令在 Blob 完成后丢失");
        }
        assertSameCommand(existing, command.commandDigest);
        if (existing.persistenceStatus !== "stored") {
          throw new Error("Trace Blob 完整身份未能绑定模型网络诊断索引");
        }
      }
    });
    await this.reconcileExpiredLateReference(command, result);
  }

  private async finalizeStatus(
    command: CapturedCommand,
    processingToken: string,
    status: "unknown" | "conflict" | "unavailable",
  ): Promise<void> {
    await this.finalize(command, async (client) => {
      const updated = await client.query(
        `UPDATE model_wire_trace_records
            SET persistence_status=$7,processing_token=NULL,processing_lease_expires_at=NULL,
                updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=$3 AND transport_attempt=$4
            AND part=$5 AND command_digest=$6 AND cleanup_command_id IS NULL
            AND processing_token=$8::uuid
            AND persistence_status<>'stored'`,
        [
          command.tenantId,
          command.attemptId,
          command.modelTurn,
          command.transportAttempt,
          command.part,
          command.commandDigest,
          status,
          processingToken,
        ],
      );
      if (updated.rowCount !== 1) {
        const existing = await readPrepared(client, command);
        if (existing === undefined) throw new Error("模型网络诊断命令在状态收敛前丢失");
        assertSameCommand(existing, command.commandDigest);
      }
    });
  }

  private async finalize(
    command: CapturedCommand,
    operation: (client: PoolClient) => Promise<void>,
  ): Promise<void> {
    let committed = false;
    try {
      await withTenantTransaction(this.pool, { tenantId: command.tenantId }, operation);
      committed = true;
      await this.options.afterCommit?.("finalize");
    } catch (error) {
      const replay = await this.readAfterAmbiguousWrite(command, error, committed, true);
      if (replay === "different") throw commandConflict();
      if (replay === "expired") return;
      if (typeof replay === "object" && replay.persistenceStatus !== "pending") return;
      throw mapPersistenceError(error, "收敛模型网络诊断命令");
    }
  }

  private async readAfterAmbiguousWrite(
    command: TraceCommandIdentity & { readonly commandDigest: string },
    error: unknown,
    committed: boolean,
    returnRecord?: false,
  ): Promise<"same" | "different" | "expired" | undefined>;
  private async readAfterAmbiguousWrite(
    command: TraceCommandIdentity & { readonly commandDigest: string },
    error: unknown,
    committed: boolean,
    returnRecord: true,
  ): Promise<PreparedCommand | "different" | "expired" | undefined>;
  private async readAfterAmbiguousWrite(
    command: TraceCommandIdentity & { readonly commandDigest: string },
    error: unknown,
    committed: boolean,
    returnRecord = false,
  ): Promise<PreparedCommand | "same" | "different" | "expired" | undefined> {
    if (
      !(error instanceof TransactionCommitUnknownError) &&
      !committed &&
      !isUniqueViolation(error)
    ) {
      return undefined;
    }
    try {
      return await withTenantTransaction(
        this.pool,
        { tenantId: command.tenantId },
        async (client) => {
          const record = await readPrepared(client, command);
          if (record !== undefined) {
            if (record.commandDigest !== command.commandDigest) return "different" as const;
            return returnRecord ? record : ("same" as const);
          }
          const digest = await tombstoneDigest(client, command);
          if (digest === undefined) return undefined;
          return digest === command.commandDigest ? ("expired" as const) : ("different" as const);
        },
      );
    } catch {
      return undefined;
    }
  }

  private async reconcileExpiredLateReference(
    command: CapturedCommand,
    result: {
      readonly referenceId: string;
      readonly blob: {
        readonly incarnationId: string;
        readonly physicalObjectKey: string;
      };
    },
  ): Promise<void> {
    await this.options.beforeLateReferenceCompensation?.();
    const cleanup = await withTenantTransaction(
      this.pool,
      { tenantId: command.tenantId },
      async (client) => {
        const tombstone = await client.query<{
          readonly cleanup_command_id: string;
          readonly command_digest: string;
        }>(
          `SELECT cleanup_command_id,command_digest
             FROM model_wire_trace_expiry_tombstones
            WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=$3
              AND transport_attempt=$4 AND part=$5`,
          [
            command.tenantId,
            command.attemptId,
            command.modelTurn,
            command.transportAttempt,
            command.part,
          ],
        );
        const expired = tombstone.rows[0];
        if (expired === undefined) return undefined;
        if (expired.command_digest !== command.commandDigest) throw commandConflict();
        const reference = await client.query<CleanupItemRow & { readonly lifecycle_id: string }>(
          `SELECT reference_id AS blob_reference_id,lifecycle_id,sha256,size,incarnation_id,
                  physical_object_key
             FROM blob_references
            WHERE tenant_id=$1 AND reference_id=$2 AND operation_id=$3 AND state='stable'
              AND purpose='trace' AND sha256=$4 AND size=$5 AND incarnation_id=$6::uuid
              AND physical_object_key=$7 FOR UPDATE`,
          [
            command.tenantId,
            result.referenceId,
            command.blobOperationId,
            command.sha256,
            command.size,
            result.blob.incarnationId,
            result.blob.physicalObjectKey,
          ],
        );
        const row = reference.rows[0];
        if (row === undefined) return undefined;
        const existingItem = await client.query<{ readonly one: number }>(
          `SELECT 1 AS one FROM model_wire_trace_cleanup_items
            WHERE tenant_id=$1 AND cleanup_command_id=$2 AND blob_reference_id=$3`,
          [command.tenantId, expired.cleanup_command_id, result.referenceId],
        );
        if (existingItem.rows[0] === undefined) {
          await client.query(
            `INSERT INTO model_wire_trace_cleanup_items(
               tenant_id,cleanup_command_id,blob_reference_id,lifecycle_id,purpose,sha256,size,
               incarnation_id,physical_object_key,state
             ) VALUES ($1,$2,$3,$4::uuid,'trace',$5,$6,$7::uuid,$8,'pending')`,
            [
              command.tenantId,
              expired.cleanup_command_id,
              result.referenceId,
              row.lifecycle_id,
              row.sha256,
              row.size,
              row.incarnation_id,
              row.physical_object_key,
            ],
          );
        }
        await client.query(
          `DELETE FROM blob_references
            WHERE tenant_id=$1 AND reference_id=$2 AND operation_id=$3 AND purpose='trace'
              AND sha256=$4 AND size=$5 AND incarnation_id=$6::uuid AND physical_object_key=$7`,
          [
            command.tenantId,
            result.referenceId,
            command.blobOperationId,
            command.sha256,
            command.size,
            result.blob.incarnationId,
            result.blob.physicalObjectKey,
          ],
        );
        await client.query(
          `UPDATE model_wire_trace_cleanup_commands
              SET status='references_released',completed_at=NULL
            WHERE tenant_id=$1 AND command_id=$2 AND status='completed'`,
          [command.tenantId, expired.cleanup_command_id],
        );
        return {
          commandId: expired.cleanup_command_id,
          referenceId: result.referenceId,
          blob: {
            kind: "stable" as const,
            tenantId: command.tenantId,
            purpose: "trace" as const,
            sha256: command.sha256,
            size: command.size,
            mediaType: "text/plain; charset=utf-8",
            incarnationId: result.blob.incarnationId,
            physicalObjectKey: result.blob.physicalObjectKey,
          },
        };
      },
    );
    if (cleanup === undefined) return;
    if (this.options.lateReferenceGc === undefined) return;
    const outcome = await this.options.lateReferenceGc.collectIfUnreachable(
      { tenantId: command.tenantId },
      cleanup.blob,
    );
    await recordGcOutcome(
      this.pool,
      command.tenantId,
      cleanup.commandId,
      cleanup.referenceId,
      outcome,
    );
  }
}

/** 到期清理命令与被清理记录在同一事务提交；COMMIT 响应未知时只读回同一 commandId。 */
export class PgModelWireTraceCleanupRepository {
  constructor(
    private readonly pool: Pool,
    private readonly gc: StableBlobGcPort,
    private readonly options: PgModelWireTraceCleanupRepositoryOptions = {},
  ) {}

  async cleanupExpired(input: ModelWireTraceCleanupCommand): Promise<ModelWireTraceCleanupResult> {
    assertCleanupInput(input);
    const digest = cleanupDigest(input);
    const existing = await withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      (client) => readCleanupCommand(client, input.tenantId, input.commandId),
    );
    if (existing !== undefined) {
      const replay = releasedCleanupReplay(existing, digest);
      if (replay.outcome === "replayed") return replay;
      return this.collectReleased(input, digest, replay.deletedCount);
    }
    let recoveryIncomplete: boolean;
    try {
      recoveryIncomplete = await this.recoverExpiredInFlight(input, false);
    } catch (error) {
      throw mapPersistenceError(error, "恢复过期模型网络诊断 Blob commit");
    }
    let committed = false;
    try {
      const result = await withTenantTransaction(
        this.pool,
        { tenantId: input.tenantId },
        async (client) => {
          const replay = await readCleanupCommand(client, input.tenantId, input.commandId);
          if (replay !== undefined) return releasedCleanupReplay(replay, digest);
          await client.query(
            `INSERT INTO model_wire_trace_cleanup_commands(
               tenant_id,command_id,command_digest,expires_before,batch_size,status
             ) VALUES ($1,$2,$3,$4,$5,'pending')`,
            [input.tenantId, input.commandId, digest, input.expiresBefore, input.batchSize],
          );
          const claimed = await client.query(
            `UPDATE model_wire_trace_records record
                SET cleanup_command_id=$2,updated_at=clock_timestamp()
              WHERE record.ctid IN (
                SELECT candidate.ctid FROM model_wire_trace_records candidate
                 WHERE candidate.tenant_id=$1 AND candidate.expires_at<=$3
                   AND candidate.expires_at<=clock_timestamp()
                   AND candidate.cleanup_command_id IS NULL
                    AND (
                      candidate.processing_token IS NULL
                      OR candidate.processing_lease_expires_at<=clock_timestamp()
                    )
                    AND NOT EXISTS (
                      SELECT 1 FROM blob_commits commit
                       WHERE commit.tenant_id=candidate.tenant_id
                         AND commit.operation_id=candidate.blob_operation_id
                         AND commit.status NOT IN ('completed','abandoned')
                    )
                 ORDER BY candidate.expires_at,candidate.attempt_id,candidate.model_turn,
                          candidate.transport_attempt,candidate.part
                 FOR UPDATE SKIP LOCKED LIMIT $4
              )
              RETURNING record.attempt_id`,
            [input.tenantId, input.commandId, input.expiresBefore, input.batchSize],
          );
          if (claimed.rowCount === 0 && recoveryIncomplete) {
            throw new PersistenceError("UNAVAILABLE", "过期 Trace Blob commit 尚未收敛");
          }
          await client.query(
            `INSERT INTO model_wire_trace_expiry_tombstones(
               tenant_id,attempt_id,model_turn,transport_attempt,part,command_digest,
               blob_operation_id,sha256,size,cleanup_command_id
             ) SELECT tenant_id,attempt_id,model_turn,transport_attempt,part,command_digest,
                      blob_operation_id,sha256,size,$2
                 FROM model_wire_trace_records
                WHERE tenant_id=$1 AND cleanup_command_id=$2`,
            [input.tenantId, input.commandId],
          );
          await client.query(
            `INSERT INTO model_wire_trace_cleanup_items(
               tenant_id,cleanup_command_id,blob_reference_id,lifecycle_id,purpose,sha256,size,
               incarnation_id,physical_object_key,state
              ) SELECT reference.tenant_id,$2,reference.reference_id,reference.lifecycle_id,
                       reference.purpose,reference.sha256,reference.size,reference.incarnation_id,
                       reference.physical_object_key,'pending'
                  FROM model_wire_trace_records record
                  JOIN blob_references reference
                    ON reference.tenant_id=record.tenant_id
                   AND reference.operation_id=record.blob_operation_id
                   AND reference.state='stable' AND reference.purpose='trace'
                   AND reference.sha256=record.sha256 AND reference.size=record.size
                 WHERE record.tenant_id=$1 AND record.cleanup_command_id=$2`,
            [input.tenantId, input.commandId],
          );
          // 复合 FK 延迟到提交检查；先持久 GC outbox，再释放专属引用与索引。
          await client.query(
            `DELETE FROM blob_references reference
              USING model_wire_trace_cleanup_items item
              WHERE item.tenant_id=$1 AND item.cleanup_command_id=$2
                AND reference.tenant_id=item.tenant_id
                AND reference.reference_id=item.blob_reference_id
                AND reference.state='stable' AND reference.purpose=item.purpose
                AND reference.sha256=item.sha256 AND reference.size=item.size
                AND reference.lifecycle_id=item.lifecycle_id
                AND reference.incarnation_id=item.incarnation_id
                AND reference.physical_object_key=item.physical_object_key`,
            [input.tenantId, input.commandId],
          );
          const removed = await client.query(
            `DELETE FROM model_wire_trace_records
              WHERE tenant_id=$1 AND cleanup_command_id=$2`,
            [input.tenantId, input.commandId],
          );
          if (removed.rowCount !== claimed.rowCount) {
            throw new Error("模型网络诊断到期批次未完整删除");
          }
          await client.query(
            `UPDATE model_wire_trace_cleanup_commands
                SET status='references_released',deleted_count=$3
              WHERE tenant_id=$1 AND command_id=$2 AND command_digest=$4 AND status='pending'`,
            [input.tenantId, input.commandId, removed.rowCount, digest],
          );
          return { outcome: "references_released" as const, deletedCount: removed.rowCount ?? 0 };
        },
      );
      committed = true;
      await this.options.afterCommit?.("cleanup");
      if (result.outcome === "replayed") return result;
      return await this.collectReleased(input, digest, result.deletedCount);
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError || committed || isUniqueViolation(error)) {
        try {
          const replay = await withTenantTransaction(
            this.pool,
            { tenantId: input.tenantId },
            (client) => readCleanupCommand(client, input.tenantId, input.commandId),
          );
          if (replay !== undefined) {
            const released = releasedCleanupReplay(replay, digest);
            if (released.outcome === "replayed") return released;
            return await this.collectReleased(input, digest, released.deletedCount);
          }
        } catch {
          // 原错误类别更稳定；读回不可用时不泄漏驱动细节。
        }
      }
      throw mapPersistenceError(error, "清理到期模型网络诊断");
    }
  }

  private async recoverExpiredInFlight(
    input: ModelWireTraceCleanupResumeInput & { readonly expiresBefore: Date },
    includeTombstones: boolean,
  ): Promise<boolean> {
    const recovery = this.options.inFlightRecovery;
    const candidates = await withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        type RecoveryCandidate = {
          readonly blob_operation_id: string;
          readonly sha256: string;
          readonly size: string | number;
          readonly blocks_cleanup: boolean;
        };
        const records = includeTombstones
          ? { rows: [] as RecoveryCandidate[] }
          : await client.query<RecoveryCandidate>(
              `WITH claimed AS (
                 SELECT record.tenant_id,record.attempt_id,record.model_turn,
                        record.transport_attempt,record.part
                   FROM model_wire_trace_records record
                   JOIN blob_commits commit
                     ON commit.tenant_id=record.tenant_id
                    AND commit.operation_id=record.blob_operation_id
                  WHERE record.tenant_id=$1 AND record.expires_at<=$2
                    AND record.expires_at<=clock_timestamp() AND record.cleanup_command_id IS NULL
                    AND record.sha256 IS NOT NULL AND record.size IS NOT NULL
                    AND (
                      record.processing_token IS NULL
                      OR record.processing_lease_expires_at<=clock_timestamp()
                    )
                    AND commit.status NOT IN ('completed','abandoned')
                  ORDER BY record.retention_recovery_at ASC NULLS FIRST,record.expires_at,
                           record.attempt_id,record.model_turn,record.transport_attempt,record.part
                  FOR UPDATE OF record SKIP LOCKED LIMIT $3
               )
               UPDATE model_wire_trace_records record
                  SET retention_recovery_at=clock_timestamp(),updated_at=clock_timestamp()
                 FROM claimed
                WHERE record.tenant_id=claimed.tenant_id
                  AND record.attempt_id=claimed.attempt_id
                  AND record.model_turn=claimed.model_turn
                  AND record.transport_attempt=claimed.transport_attempt
                  AND record.part=claimed.part
               RETURNING record.blob_operation_id,record.sha256,record.size,
                         true AS blocks_cleanup`,
              [input.tenantId, input.expiresBefore, input.batchSize],
            );
        const tombstones = includeTombstones
          ? await client.query<RecoveryCandidate>(
              `WITH claimed AS (
             SELECT tombstone.tenant_id,tombstone.attempt_id,tombstone.model_turn,
                    tombstone.transport_attempt,tombstone.part
               FROM model_wire_trace_expiry_tombstones tombstone
              WHERE tombstone.tenant_id=$1
                AND tombstone.sha256 IS NOT NULL AND tombstone.size IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM blob_commits commit
                   WHERE commit.tenant_id=tombstone.tenant_id
                     AND commit.operation_id=tombstone.blob_operation_id
                )
              ORDER BY tombstone.staging_swept_at ASC NULLS FIRST,tombstone.expired_at,
                       tombstone.attempt_id,tombstone.model_turn,
                       tombstone.transport_attempt,tombstone.part
              FOR UPDATE SKIP LOCKED LIMIT $2
           )
           UPDATE model_wire_trace_expiry_tombstones tombstone
              SET staging_swept_at=clock_timestamp()
             FROM claimed
            WHERE tombstone.tenant_id=claimed.tenant_id
              AND tombstone.attempt_id=claimed.attempt_id
              AND tombstone.model_turn=claimed.model_turn
              AND tombstone.transport_attempt=claimed.transport_attempt
              AND tombstone.part=claimed.part
           RETURNING tombstone.blob_operation_id,tombstone.sha256,tombstone.size,
                     false AS blocks_cleanup`,
              [input.tenantId, input.batchSize],
            )
          : { rows: [] as RecoveryCandidate[] };
        const deduplicated = new Map<string, RecoveryCandidate>();
        for (const candidate of [...records.rows, ...tombstones.rows]) {
          deduplicated.set(candidate.blob_operation_id, candidate);
        }
        return [...deduplicated.values()];
      },
    );
    if (candidates.length === 0) return false;
    if (recovery === undefined) {
      return true;
    }
    const adapter = new DurableTraceBlobPersistenceAdapter(recovery.commits, recovery.blobs);
    let incomplete = false;
    for (const candidate of candidates) {
      const outcome = await adapter.recoverForRetention({
        tenantId: input.tenantId,
        operationId: candidate.blob_operation_id,
        sha256: candidate.sha256,
        size: Number(candidate.size),
      });
      if (outcome === "conflict") {
        throw new PersistenceError(
          "CONSTRAINT_VIOLATION",
          "过期 Trace Blob commit 身份与索引不一致",
        );
      }
      if (outcome === "retry" || outcome === "deferred") {
        if (candidate.blocks_cleanup) {
          incomplete = true;
        }
      }
    }
    return incomplete;
  }

  /** 周期 consumer 入口：扫描引用已释放但正文 GC 尚未完成的命令，进程重启后可继续。 */
  async resumePending(input: ModelWireTraceCleanupResumeInput): Promise<number> {
    assertCleanupResumeInput(input);
    try {
      await this.recoverExpiredInFlight({ ...input, expiresBefore: new Date() }, true);
    } catch (error) {
      throw mapPersistenceError(error, "恢复墓碑关联的模型网络诊断 Blob commit");
    }
    await this.reconcileTombstoneReferences(input);
    const commands = await withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        const result = await client.query<{
          readonly command_id: string;
          readonly command_digest: string;
          readonly expires_before: Date;
          readonly batch_size: number;
          readonly deleted_count: number;
        }>(
          `SELECT command_id,command_digest,expires_before,batch_size,deleted_count
             FROM model_wire_trace_cleanup_commands
            WHERE tenant_id=$1 AND status='references_released'
            ORDER BY created_at,command_id LIMIT $2`,
          [input.tenantId, input.batchSize],
        );
        return result.rows;
      },
    );
    let completed = 0;
    for (const command of commands) {
      const result = await this.collectReleased(
        {
          tenantId: input.tenantId,
          commandId: command.command_id,
          expiresBefore:
            command.expires_before instanceof Date
              ? command.expires_before
              : new Date(command.expires_before),
          batchSize: Number(command.batch_size),
        },
        command.command_digest,
        Number(command.deleted_count),
      );
      if (result.outcome === "completed" || result.outcome === "replayed") completed += 1;
    }
    return completed;
  }

  private async reconcileTombstoneReferences(
    input: ModelWireTraceCleanupResumeInput,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      const late = await client.query<
        CleanupItemRow & { readonly lifecycle_id: string; readonly cleanup_command_id: string }
      >(
        `SELECT reference.reference_id AS blob_reference_id,reference.lifecycle_id,
                reference.sha256,reference.size,reference.incarnation_id,
                reference.physical_object_key,tombstone.cleanup_command_id
           FROM model_wire_trace_expiry_tombstones tombstone
           JOIN blob_references reference
             ON reference.tenant_id=tombstone.tenant_id
            AND reference.operation_id=tombstone.blob_operation_id
            AND reference.purpose='trace' AND reference.state='stable'
            AND reference.sha256=tombstone.sha256 AND reference.size=tombstone.size
           LEFT JOIN model_wire_trace_cleanup_items item
             ON item.tenant_id=tombstone.tenant_id
            AND item.cleanup_command_id=tombstone.cleanup_command_id
            AND item.blob_reference_id=reference.reference_id
          WHERE tombstone.tenant_id=$1 AND item.blob_reference_id IS NULL
          ORDER BY tombstone.expired_at,tombstone.attempt_id,tombstone.model_turn,
                   tombstone.transport_attempt,tombstone.part
          FOR UPDATE OF reference SKIP LOCKED LIMIT $2`,
        [input.tenantId, input.batchSize],
      );
      for (const row of late.rows) {
        await client.query(
          `INSERT INTO model_wire_trace_cleanup_items(
             tenant_id,cleanup_command_id,blob_reference_id,lifecycle_id,purpose,sha256,size,
             incarnation_id,physical_object_key,state
           ) VALUES ($1,$2,$3,$4::uuid,'trace',$5,$6,$7::uuid,$8,'pending')`,
          [
            input.tenantId,
            row.cleanup_command_id,
            row.blob_reference_id,
            row.lifecycle_id,
            row.sha256,
            row.size,
            row.incarnation_id,
            row.physical_object_key,
          ],
        );
        await client.query(
          `DELETE FROM blob_references
            WHERE tenant_id=$1 AND reference_id=$2 AND purpose='trace'
              AND sha256=$3 AND size=$4 AND incarnation_id=$5::uuid
              AND physical_object_key=$6`,
          [
            input.tenantId,
            row.blob_reference_id,
            row.sha256,
            row.size,
            row.incarnation_id,
            row.physical_object_key,
          ],
        );
        await client.query(
          `UPDATE model_wire_trace_cleanup_commands
              SET status='references_released',completed_at=NULL
            WHERE tenant_id=$1 AND command_id=$2 AND status='completed'`,
          [input.tenantId, row.cleanup_command_id],
        );
      }
    });
  }

  private async collectReleased(
    input: ModelWireTraceCleanupCommand,
    commandDigest: string,
    deletedCount: number,
  ): Promise<ModelWireTraceCleanupResult> {
    const items = await withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        const command = await readCleanupCommand(client, input.tenantId, input.commandId);
        if (command === undefined || command.command_digest !== commandDigest)
          throw commandConflict();
        if (command.status === "completed") return [];
        if (command.status !== "references_released") {
          throw new PersistenceError("UNAVAILABLE", "模型网络诊断引用尚未释放");
        }
        const result = await client.query<CleanupItemRow>(
          `SELECT blob_reference_id,sha256,size,incarnation_id,physical_object_key
             FROM model_wire_trace_cleanup_items
            WHERE tenant_id=$1 AND cleanup_command_id=$2 AND state<>'completed'
            ORDER BY blob_reference_id`,
          [input.tenantId, input.commandId],
        );
        return result.rows;
      },
    );
    for (const item of items) {
      const blob: StableBlobRef = {
        kind: "stable",
        tenantId: input.tenantId,
        purpose: "trace",
        sha256: item.sha256,
        size: Number(item.size),
        mediaType: "text/plain; charset=utf-8",
        incarnationId: item.incarnation_id,
        physicalObjectKey: item.physical_object_key,
      };
      let outcome: "deleted" | "still_referenced" | "in_progress";
      try {
        outcome = await this.gc.collectIfUnreachable({ tenantId: input.tenantId }, blob);
      } catch (error) {
        await this.markGcRetry(input, item.blob_reference_id);
        throw mapPersistenceError(error, "回收模型网络诊断正文");
      }
      if (outcome === "in_progress") {
        await this.markGcRetry(input, item.blob_reference_id);
        throw new PersistenceError("UNAVAILABLE", "模型网络诊断正文 GC 正在重试");
      }
      await recordGcOutcome(
        this.pool,
        input.tenantId,
        input.commandId,
        item.blob_reference_id,
        outcome,
      );
    }
    let committed = false;
    try {
      await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
        const pending = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM model_wire_trace_cleanup_items
            WHERE tenant_id=$1 AND cleanup_command_id=$2 AND state<>'completed'`,
          [input.tenantId, input.commandId],
        );
        if (pending.rows[0]?.count !== "0") {
          throw new PersistenceError("UNAVAILABLE", "模型网络诊断正文 GC 尚未完成");
        }
        await this.options.beforeCompletionTransition?.();
        const updated = await client.query(
          `UPDATE model_wire_trace_cleanup_commands command
              SET status='completed',completed_at=clock_timestamp()
            WHERE command.tenant_id=$1 AND command.command_id=$2 AND command.command_digest=$3
              AND command.status='references_released'
              AND NOT EXISTS (
                SELECT 1 FROM model_wire_trace_cleanup_items item
                 WHERE item.tenant_id=command.tenant_id
                   AND item.cleanup_command_id=command.command_id
                   AND item.state<>'completed'
              )`,
          [input.tenantId, input.commandId, commandDigest],
        );
        if (updated.rowCount !== 1) {
          const replay = await readCleanupCommand(client, input.tenantId, input.commandId);
          if (replay?.command_digest === commandDigest && replay.status === "references_released") {
            throw new PersistenceError("UNAVAILABLE", "模型网络诊断正文 GC 出现新的待处理引用");
          }
          if (replay?.status !== "completed" || replay.command_digest !== commandDigest) {
            throw new Error("模型网络诊断清理完成事实未收敛");
          }
        }
      });
      committed = true;
      await this.options.afterCommit?.("cleanup");
      return { outcome: "completed", deletedCount };
    } catch (error) {
      if (error instanceof TransactionCommitUnknownError || committed) {
        const replay = await withTenantTransaction(
          this.pool,
          { tenantId: input.tenantId },
          (client) => readCleanupCommand(client, input.tenantId, input.commandId),
        ).catch(() => undefined);
        if (replay?.status === "completed" && replay.command_digest === commandDigest) {
          return { outcome: "replayed", deletedCount: Number(replay.deleted_count) };
        }
      }
      throw mapPersistenceError(error, "提交模型网络诊断正文 GC 事实");
    }
  }

  private async markGcRetry(
    input: ModelWireTraceCleanupCommand,
    referenceId: string,
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: input.tenantId }, (client) =>
      client.query(
        `UPDATE model_wire_trace_cleanup_items
            SET state='retry',attempt_count=attempt_count+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND cleanup_command_id=$2 AND blob_reference_id=$3
            AND state<>'completed'`,
        [input.tenantId, input.commandId, referenceId],
      ),
    ).catch(() => undefined);
  }
}

function capturedCommand(input: ModelWireTracePersistInput): CapturedCommand {
  const identity = identityOfInput(input);
  const commandDigest = digest([
    1,
    input.context.tenantId,
    input.context.threadId,
    input.context.runId,
    input.context.attemptId,
    input.modelTurn,
    input.transportAttempt,
    input.part,
    input.status,
    input.sha256,
    input.size,
    input.httpStatus ?? null,
  ]);
  return {
    ...identity,
    context: input.context,
    commandDigest,
    blobOperationId: blobOperationId(identity),
    captureStatus: input.status,
    sha256: input.sha256,
    size: input.size,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
  };
}

function failedCommand(input: ModelWireTraceCaptureFailedInput) {
  const identity = identityOfInput(input);
  return {
    ...identity,
    commandDigest: digest([
      1,
      input.context.tenantId,
      input.context.threadId,
      input.context.runId,
      input.context.attemptId,
      input.modelTurn,
      input.transportAttempt,
      input.part,
      input.code,
      input.httpStatus ?? null,
    ]),
    blobOperationId: blobOperationId(identity),
  };
}

function identityOfInput(
  input: Pick<ModelWireTracePersistInput, "context" | "modelTurn" | "transportAttempt" | "part">,
): TraceCommandIdentity {
  return {
    tenantId: input.context.tenantId,
    attemptId: input.context.attemptId,
    modelTurn: input.modelTurn,
    transportAttempt: input.transportAttempt,
    part: input.part,
  };
}

function identityOf(input: TraceCommandIdentity): TraceCommandIdentity {
  return {
    tenantId: input.tenantId,
    attemptId: input.attemptId,
    modelTurn: input.modelTurn,
    transportAttempt: input.transportAttempt,
    part: input.part,
  };
}

function wireOperationKey(input: TraceCommandIdentity): string {
  return `wire.${input.attemptId}.${input.modelTurn}.${input.transportAttempt}.${input.part}`;
}

function blobOperationId(input: TraceCommandIdentity): string {
  return `trace-${createHash("sha256").update(wireOperationKey(input), "utf8").digest("hex")}`;
}

async function readPrepared(
  client: PoolClient,
  input: TraceCommandIdentity,
  forUpdate = false,
): Promise<PreparedCommand | undefined> {
  const result = await client.query<QueryResultRow>(
    `SELECT command_digest,blob_operation_id,persistence_status,processing_token,
            processing_lease_expires_at,cleanup_command_id
       FROM model_wire_trace_records
      WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=$3
        AND transport_attempt=$4 AND part=$5${forUpdate ? " FOR UPDATE" : ""}`,
    [input.tenantId, input.attemptId, input.modelTurn, input.transportAttempt, input.part],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    ...identityOf(input),
    commandDigest: String(row.command_digest),
    blobOperationId: String(row.blob_operation_id),
    persistenceStatus: String(row.persistence_status) as PersistenceStatus,
    ...(row.processing_token === null || row.processing_token === undefined
      ? {}
      : { processingToken: String(row.processing_token) }),
    ...(row.processing_lease_expires_at === null || row.processing_lease_expires_at === undefined
      ? {}
      : {
          processingLeaseExpiresAt:
            row.processing_lease_expires_at instanceof Date
              ? row.processing_lease_expires_at
              : new Date(String(row.processing_lease_expires_at)),
        }),
    ...(row.cleanup_command_id === null || row.cleanup_command_id === undefined
      ? {}
      : { cleanupCommandId: String(row.cleanup_command_id) }),
  };
}

async function tombstoneDigest(
  client: PoolClient,
  input: TraceCommandIdentity,
): Promise<string | undefined> {
  const result = await client.query<{ readonly command_digest: string }>(
    `SELECT command_digest FROM model_wire_trace_expiry_tombstones
      WHERE tenant_id=$1 AND attempt_id=$2 AND model_turn=$3
        AND transport_attempt=$4 AND part=$5`,
    [input.tenantId, input.attemptId, input.modelTurn, input.transportAttempt, input.part],
  );
  return result.rows[0]?.command_digest;
}

interface CleanupRow {
  readonly command_digest: string;
  readonly status: "pending" | "references_released" | "completed";
  readonly deleted_count: number | null;
}

interface CleanupItemRow {
  readonly blob_reference_id: string;
  readonly sha256: string;
  readonly size: string | number;
  readonly incarnation_id: string;
  readonly physical_object_key: string;
}

async function readCleanupCommand(
  client: PoolClient,
  tenantId: string,
  commandId: string,
): Promise<CleanupRow | undefined> {
  const result = await client.query<CleanupRow>(
    `SELECT command_digest,status,deleted_count
       FROM model_wire_trace_cleanup_commands
      WHERE tenant_id=$1 AND command_id=$2`,
    [tenantId, commandId],
  );
  return result.rows[0];
}

async function recordGcOutcome(
  pool: Pool,
  tenantId: string,
  commandId: string,
  referenceId: string,
  outcome: "deleted" | "still_referenced" | "in_progress",
): Promise<void> {
  await withTenantTransaction(pool, { tenantId }, async (client) => {
    if (outcome === "in_progress") {
      await client.query(
        `UPDATE model_wire_trace_cleanup_items
            SET state='retry',attempt_count=attempt_count+1,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND cleanup_command_id=$2 AND blob_reference_id=$3
            AND state<>'completed'`,
        [tenantId, commandId, referenceId],
      );
      return;
    }
    await client.query(
      `UPDATE model_wire_trace_cleanup_items
          SET state='completed',outcome=$4,attempt_count=attempt_count+1,
              updated_at=clock_timestamp()
        WHERE tenant_id=$1 AND cleanup_command_id=$2 AND blob_reference_id=$3
          AND state<>'completed'`,
      [tenantId, commandId, referenceId, outcome],
    );
    await client.query(
      `UPDATE model_wire_trace_cleanup_commands command
          SET status='completed',completed_at=clock_timestamp()
        WHERE command.tenant_id=$1 AND command.command_id=$2
          AND command.status='references_released'
          AND NOT EXISTS (
            SELECT 1 FROM model_wire_trace_cleanup_items item
             WHERE item.tenant_id=command.tenant_id
               AND item.cleanup_command_id=command.command_id AND item.state<>'completed'
          )`,
      [tenantId, commandId],
    );
  });
}

function releasedCleanupReplay(
  row: CleanupRow,
  digestValue: string,
):
  | ModelWireTraceCleanupResult
  | { readonly outcome: "references_released"; readonly deletedCount: number } {
  if (row.command_digest !== digestValue) throw commandConflict();
  if (row.status === "pending" || row.deleted_count === null) {
    throw new PersistenceError("UNAVAILABLE", "模型网络诊断清理命令尚未完成");
  }
  return row.status === "completed"
    ? { outcome: "replayed", deletedCount: Number(row.deleted_count) }
    : { outcome: "references_released", deletedCount: Number(row.deleted_count) };
}

function cleanupDigest(input: ModelWireTraceCleanupCommand): string {
  return digest([
    1,
    input.tenantId,
    input.commandId,
    input.expiresBefore.toISOString(),
    input.batchSize,
  ]);
}

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function assertSameCommand(existing: PreparedCommand, expectedDigest: string): void {
  if (existing.commandDigest !== expectedDigest) throw commandConflict();
}

function commandConflict(): PersistenceError {
  return new PersistenceError("CONFLICT", "模型网络诊断幂等键绑定了不同命令");
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function assertIdentity(input: {
  readonly context: ModelWireTraceContext;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: string;
  readonly httpStatus?: number;
}): void {
  const agentIdentity = [input.context.agentThreadId, input.context.agentTurnId];
  if (agentIdentity.filter((value) => value !== undefined).length === 1) {
    throw new TypeError("模型网络诊断子 Agent 身份不完整");
  }
  for (const value of [
    input.context.tenantId,
    input.context.threadId,
    input.context.runId,
    input.context.attemptId,
    ...agentIdentity.filter((item): item is string => item !== undefined),
  ]) {
    if (Buffer.byteLength(value, "utf8") < 1 || Buffer.byteLength(value, "utf8") > 200)
      throw new TypeError("模型网络诊断身份长度无效");
  }
  for (const value of [input.modelTurn, input.transportAttempt]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("模型网络诊断序号无效");
  }
  if (input.part !== "request" && input.part !== "response")
    throw new TypeError("模型网络诊断报文部分无效");
  if (
    input.httpStatus !== undefined &&
    (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)
  )
    throw new TypeError("模型网络诊断 HTTP 状态无效");
}

function assertPersistInput(input: ModelWireTracePersistInput): void {
  assertIdentity(input);
  if (!/^[0-9a-f]{64}$/u.test(input.sha256)) throw new TypeError("模型网络诊断摘要无效");
  if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size !== input.body.byteLength)
    throw new TypeError("模型网络诊断大小与正文不一致");
  const actual = createHash("sha256").update(input.body).digest("hex");
  if (actual !== input.sha256) throw new TypeError("模型网络诊断正文摘要不一致");
}

function assertCaptureFailedInput(input: ModelWireTraceCaptureFailedInput): void {
  assertIdentity(input);
  if (input.code !== "CAPTURE_UNAVAILABLE" && input.code !== "BODY_UNREADABLE")
    throw new TypeError("模型网络诊断捕获错误码无效");
}

function assertCleanupInput(input: ModelWireTraceCleanupCommand): void {
  if (
    Buffer.byteLength(input.tenantId, "utf8") < 1 ||
    Buffer.byteLength(input.tenantId, "utf8") > 200
  )
    throw new TypeError("模型网络诊断清理 Tenant 无效");
  if (
    Buffer.byteLength(input.commandId, "utf8") < 1 ||
    Buffer.byteLength(input.commandId, "utf8") > 200
  )
    throw new TypeError("模型网络诊断清理命令 ID 无效");
  if (!(input.expiresBefore instanceof Date) || !Number.isFinite(input.expiresBefore.getTime()))
    throw new TypeError("模型网络诊断清理截止时间无效");
  if (input.expiresBefore.getTime() > Date.now())
    throw new TypeError("模型网络诊断清理截止时间不能位于未来");
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500)
    throw new TypeError("模型网络诊断清理批量无效");
}

function assertCleanupResumeInput(input: ModelWireTraceCleanupResumeInput): void {
  if (
    Buffer.byteLength(input.tenantId, "utf8") < 1 ||
    Buffer.byteLength(input.tenantId, "utf8") > 200
  )
    throw new TypeError("模型网络诊断恢复清理 Tenant 无效");
  if (!Number.isSafeInteger(input.batchSize) || input.batchSize < 1 || input.batchSize > 500)
    throw new TypeError("模型网络诊断恢复清理批量无效");
}
