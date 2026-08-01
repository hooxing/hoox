import { createHash, randomUUID } from "node:crypto";
import type { ThreadContinuityMetricsPort } from "@cube-runtime/run-contracts";
import { digestCanonical } from "@cube-runtime/run-contracts/mutation-protocol";
import type { Pool, PoolClient } from "pg";
import type { ThreadContinuityReadPort, ThreadContinuityStatusView } from "./ports.js";
import { withTenantTransaction } from "./postgres.js";

interface LegacyAnchorSnapshot {
  readonly anchorId: string;
  readonly firstSequence: number;
  readonly anchorSequence: number;
  readonly selectedRuns: number;
  readonly backfilledEntries: number;
  readonly gapItems: number;
}

export type LegacyThreadAnchorResult =
  | ({ readonly outcome: "anchored" } & LegacyAnchorSnapshot)
  | ({ readonly outcome: "replayed" } & LegacyAnchorSnapshot)
  | { readonly outcome: "busy" | "not_found" | "not_legacy" };

interface LegacyRunRow {
  readonly run_id: string;
  readonly run_status: "succeeded" | "failed" | "cancelled";
  readonly run_created_at: Date | string;
  readonly run_updated_at: Date | string;
  readonly input_text: string | null;
  readonly input_created_at: Date | string | null;
  readonly result_outcome: "committed" | "unchanged" | "failed_before_commit" | null;
  readonly result_revision_id: string | null;
  readonly result_manifest_digest: string | null;
  readonly result_committed_at: Date | string | null;
  readonly revision_id: string | null;
  readonly revision_digest: string | null;
  readonly revision_created_at: Date | string | null;
}

interface PendingEntry {
  readonly entryId: string;
  readonly runId?: string;
  readonly kind:
    | "user_message"
    | "workspace_committed"
    | "workspace_unchanged"
    | "run_terminal"
    | "legacy_history_gap"
    | "legacy_v2_anchor";
  readonly body: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date | string;
  readonly audit?: Omit<PendingAudit, "contextSequence">;
}

interface PendingAudit {
  readonly sourceRunId?: string;
  readonly evidenceKind:
    | "user_input"
    | "workspace_result"
    | "run_terminal"
    | "assistant_tool_history"
    | "earlier_run_range"
    | "existing_v2_stream";
  readonly outcome: "backfilled" | "already_present" | "gap";
  readonly contextSequence?: number;
  readonly sourceDigest: string;
  readonly reasonCode?:
    | "source_missing"
    | "not_provable"
    | "max_depth_exceeded"
    | "cannot_prepend_existing_stream";
}

/** cohort 只决定未来新 Thread 是否进入样本，不包含用户正文，也不是安全散列。 */
export function threadContinuityCohortBucket(tenantId: string, threadId: string): number {
  if (!tenantId.trim() || !threadId.trim()) throw new TypeError("Thread rollout identity 无效");
  const prefix = createHash("sha256")
    .update(tenantId, "utf8")
    .update("\0")
    .update(threadId, "utf8")
    .digest("hex")
    .slice(0, 12);
  return Number.parseInt(prefix, 16) % 10_000;
}

export async function isThreadV2ReadEnabled(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<boolean> {
  const result = await client.query<{ readonly enabled: boolean }>(
    `SELECT (
       COALESCE(policy.v2_read_enabled, true)
       AND profile.rollout_selected
       AND (profile.rollout_source <> 'legacy_anchor'
            OR COALESCE(policy.legacy_anchor_read_enabled, true))
     ) AS enabled
       FROM thread_continuity_profiles profile
       LEFT JOIN tenant_thread_continuity_policies policy ON policy.tenant_id=profile.tenant_id
      WHERE profile.tenant_id=$1 AND profile.thread_id=$2`,
    [tenantId, threadId],
  );
  return result.rows[0]?.enabled === true;
}

/**
 * 旧 Thread 只回填数据库能逐项证明的 user/workspace/terminal 事实。
 * Assistant/tool 历史没有足够 finality 证明时一律写 gap，不读取模型生成迁移摘要。
 */
export class PgLegacyThreadContextAnchor {
  constructor(private readonly pool: Pool) {}

  async anchor(input: {
    readonly tenantId: string;
    readonly threadId: string;
    readonly maxRuns: number;
    readonly operationId?: string;
  }): Promise<LegacyThreadAnchorResult> {
    if (
      !input.tenantId.trim() ||
      !input.threadId.trim() ||
      !Number.isSafeInteger(input.maxRuns) ||
      input.maxRuns < 1 ||
      input.maxRuns > 10_000
    ) {
      throw new TypeError("legacy anchor 参数无效");
    }
    const operationId = input.operationId ?? `legacy-anchor-operation-${randomUUID()}`;
    if (
      Buffer.byteLength(operationId, "utf8") < 8 ||
      Buffer.byteLength(operationId, "utf8") > 512
    ) {
      throw new TypeError("legacy anchor operationId 无效");
    }
    return withTenantTransaction(
      this.pool,
      { tenantId: input.tenantId },
      async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))", [
          `${input.tenantId}\u001f${input.threadId}\u001flegacy-context-anchor`,
        ]);
        const replay = await readAnchor(client, input.tenantId, input.threadId);
        if (replay !== undefined) return { outcome: "replayed", ...replay } as const;
        const thread = await client.query<{
          readonly created_at: Date | string;
          readonly active_run_id: string | null;
          readonly writer_active: boolean;
        }>(
          `SELECT thread.created_at,head.active_run_id,
                  (head.writer_token IS NOT NULL
                   AND head.writer_expires_at > clock_timestamp()) AS writer_active
             FROM threads thread
             JOIN thread_execution_heads head
               ON head.tenant_id=thread.tenant_id AND head.thread_id=thread.id
            WHERE thread.tenant_id=$1 AND thread.id=$2
            FOR UPDATE OF thread,head`,
          [input.tenantId, input.threadId],
        );
        const threadRow = thread.rows[0];
        if (threadRow === undefined) return { outcome: "not_found" } as const;
        const existingProfile = await client.query<{ readonly rollout_source: string }>(
          `SELECT rollout_source FROM thread_continuity_profiles
            WHERE tenant_id=$1 AND thread_id=$2`,
          [input.tenantId, input.threadId],
        );
        if (existingProfile.rowCount !== 0) return { outcome: "not_legacy" } as const;
        const nonterminal = await client.query(
          `SELECT 1 FROM runs WHERE tenant_id=$1 AND thread_id=$2
            AND status IN ('queued','running','waiting') LIMIT 1`,
          [input.tenantId, input.threadId],
        );
        if (
          threadRow.active_run_id !== null ||
          threadRow.writer_active ||
          nonterminal.rowCount !== 0
        ) {
          return { outcome: "busy" } as const;
        }
        const totalResult = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM runs
            WHERE tenant_id=$1 AND thread_id=$2 AND status IN ('succeeded','failed','cancelled')`,
          [input.tenantId, input.threadId],
        );
        const totalTerminalRuns = Number(totalResult.rows[0]?.count ?? "0");
        const runsResult = await client.query<LegacyRunRow>(
          `SELECT run.id AS run_id,run.status AS run_status,
                  run.created_at AS run_created_at,run.updated_at AS run_updated_at,
                  input.input_text,input.created_at AS input_created_at,
                  result.outcome AS result_outcome,result.result_revision_id,
                  result.manifest_digest AS result_manifest_digest,
                  result.committed_at AS result_committed_at,
                  revision.id AS revision_id,revision.digest AS revision_digest,
                  revision.created_at AS revision_created_at
             FROM runs run
             LEFT JOIN run_execution_inputs input
               ON input.tenant_id=run.tenant_id AND input.run_id=run.id
             LEFT JOIN run_workspace_results result
               ON result.tenant_id=run.tenant_id AND result.run_id=run.id
             LEFT JOIN LATERAL (
               SELECT candidate.id,candidate.digest,candidate.created_at
                 FROM workspace_revisions candidate
                WHERE candidate.tenant_id=run.tenant_id AND candidate.thread_id=run.thread_id
                  AND candidate.created_by_run_id=run.id
                ORDER BY candidate.revision_number DESC LIMIT 1
             ) revision ON true
            WHERE run.tenant_id=$1 AND run.thread_id=$2
              AND run.status IN ('succeeded','failed','cancelled')
            ORDER BY run.created_at DESC,run.id DESC LIMIT $3`,
          [input.tenantId, input.threadId, input.maxRuns],
        );
        const runs = [...runsResult.rows].reverse();
        const stream = await client.query<{ readonly next_sequence: string }>(
          `SELECT next_sequence::text FROM thread_context_streams
            WHERE tenant_id=$1 AND thread_id=$2 FOR UPDATE`,
          [input.tenantId, input.threadId],
        );
        const firstSequence = safeSequence(stream.rows[0]?.next_sequence);
        const streamAlreadyHadFacts = firstSequence > 1;
        const anchorId = `legacy-anchor-${randomUUID()}`;
        const sourceDigest = digestCanonical({
          schemaVersion: 1,
          tenantId: input.tenantId,
          threadId: input.threadId,
          maxRuns: input.maxRuns,
          totalTerminalRuns,
          runs,
        });
        const gapReasons = new Set<string>();
        const audits: PendingAudit[] = [];
        const entries: PendingEntry[] = [];
        const gapOccurredAt = runs[0]?.run_created_at ?? threadRow.created_at;
        if (streamAlreadyHadFacts) {
          gapReasons.add("existing_v2_stream_prevents_prepend");
          audits.push({
            evidenceKind: "existing_v2_stream",
            outcome: "gap",
            sourceDigest,
            reasonCode: "cannot_prepend_existing_stream",
          });
        } else {
          if (totalTerminalRuns > runs.length) {
            gapReasons.add("backfill_max_depth_exceeded");
            audits.push({
              evidenceKind: "earlier_run_range",
              outcome: "gap",
              sourceDigest: digestCanonical({ totalTerminalRuns, selectedRuns: runs.length }),
              reasonCode: "max_depth_exceeded",
            });
          }
          for (const run of runs) {
            if (run.input_text === null) {
              gapReasons.add("user_input_source_missing");
              audits.push({
                sourceRunId: run.run_id,
                evidenceKind: "user_input",
                outcome: "gap",
                sourceDigest: digestCanonical({ runId: run.run_id, source: null }),
                reasonCode: "source_missing",
              });
            } else {
              const body = { text: run.input_text, source: "run_execution_inputs" } as const;
              entries.push({
                entryId: `${anchorId}:${run.run_id}:user`,
                runId: run.run_id,
                kind: "user_message",
                body,
                occurredAt: run.input_created_at ?? run.run_created_at,
                audit: {
                  sourceRunId: run.run_id,
                  evidenceKind: "user_input",
                  outcome: "backfilled",
                  sourceDigest: digestCanonical(body),
                },
              });
            }
            const workspace = legacyWorkspaceEntry(anchorId, run);
            if (workspace !== undefined) {
              entries.push(workspace);
            } else {
              gapReasons.add("workspace_history_not_provable");
              audits.push({
                sourceRunId: run.run_id,
                evidenceKind: "workspace_result",
                outcome: "gap",
                sourceDigest: digestCanonical({
                  runId: run.run_id,
                  resultOutcome: run.result_outcome,
                  resultRevisionId: run.result_revision_id,
                  revisionId: run.revision_id,
                }),
                reasonCode: run.result_outcome === null ? "source_missing" : "not_provable",
              });
            }
            const terminalBody = { status: run.run_status, source: "runs" } as const;
            entries.push({
              entryId: `${anchorId}:${run.run_id}:terminal`,
              runId: run.run_id,
              kind: "run_terminal",
              body: terminalBody,
              occurredAt: run.run_updated_at,
              audit: {
                sourceRunId: run.run_id,
                evidenceKind: "run_terminal",
                outcome: "backfilled",
                sourceDigest: digestCanonical(terminalBody),
              },
            });
            gapReasons.add("assistant_tool_history_not_provable");
            audits.push({
              sourceRunId: run.run_id,
              evidenceKind: "assistant_tool_history",
              outcome: "gap",
              sourceDigest: digestCanonical({ runId: run.run_id, source: "not_selected" }),
              reasonCode: "not_provable",
            });
          }
        }
        if (gapReasons.size > 0) {
          const gapBody = {
            code: "legacy_history_gap",
            reasons: [...gapReasons].sort(),
            totalTerminalRuns,
            selectedRuns: runs.length,
            message: "旧 Thread 仅回填可由持久事实证明的历史；缺失部分不得推断为完整对话。",
          } as const;
          entries.unshift({
            entryId: `${anchorId}:gap`,
            kind: "legacy_history_gap",
            body: gapBody,
            occurredAt: gapOccurredAt,
          });
        }
        entries.push({
          entryId: `${anchorId}:marker`,
          kind: "legacy_v2_anchor",
          body: {
            anchorId,
            sourceDigest,
            totalTerminalRuns,
            selectedRuns: runs.length,
            maxRuns: input.maxRuns,
          },
          occurredAt: new Date(),
        });
        for (const [index, entry] of entries.entries()) {
          const sequence = firstSequence + index;
          await insertLegacyEntry(client, input.tenantId, input.threadId, sequence, entry);
          if (entry.audit !== undefined) audits.push({ ...entry.audit, contextSequence: sequence });
        }
        const anchorSequence = firstSequence + entries.length - 1;
        const advanced = await client.query(
          `UPDATE thread_context_streams SET next_sequence=$3+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND thread_id=$2 AND next_sequence=$4`,
          [input.tenantId, input.threadId, anchorSequence, firstSequence],
        );
        if (advanced.rowCount !== 1) throw new Error("legacy anchor stream CAS 冲突");
        const headAdvanced = await client.query(
          `UPDATE thread_execution_heads
              SET context_through_sequence=$3,version=version+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1 AND thread_id=$2 AND active_run_id IS NULL`,
          [input.tenantId, input.threadId, anchorSequence],
        );
        if (headAdvanced.rowCount !== 1) throw new Error("legacy anchor head CAS 冲突");
        const backfilledEntries = audits.filter((item) => item.outcome === "backfilled").length;
        const gapItems = audits.filter((item) => item.outcome === "gap").length;
        await client.query(
          `INSERT INTO thread_context_legacy_anchors(
             tenant_id,thread_id,anchor_id,operation_id,max_runs,total_terminal_runs,
             selected_runs,backfilled_entries,gap_items,first_context_sequence,
             anchor_context_sequence,source_digest,gap_reasons
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
          [
            input.tenantId,
            input.threadId,
            anchorId,
            operationId,
            input.maxRuns,
            totalTerminalRuns,
            runs.length,
            backfilledEntries,
            gapItems,
            firstSequence,
            anchorSequence,
            sourceDigest,
            JSON.stringify([...gapReasons].sort()),
          ],
        );
        for (const [itemOrdinal, audit] of audits.entries()) {
          await client.query(
            `INSERT INTO thread_context_legacy_backfill_items(
               tenant_id,thread_id,anchor_id,item_ordinal,source_run_id,evidence_kind,
               outcome,context_sequence,source_digest,reason_code
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              input.tenantId,
              input.threadId,
              anchorId,
              itemOrdinal,
              audit.sourceRunId ?? null,
              audit.evidenceKind,
              audit.outcome,
              audit.contextSequence ?? null,
              audit.sourceDigest,
              audit.reasonCode ?? null,
            ],
          );
        }
        await client.query(
          `INSERT INTO thread_continuity_profiles(
             tenant_id,thread_id,rollout_source,cohort_bucket,rollout_selected,policy_version,anchor_id
           ) SELECT $1,$2,'legacy_anchor',$3,true,COALESCE(policy.policy_version,0),$4
               FROM (SELECT 1) singleton
               LEFT JOIN tenant_thread_continuity_policies policy ON policy.tenant_id=$1`,
          [
            input.tenantId,
            input.threadId,
            threadContinuityCohortBucket(input.tenantId, input.threadId),
            anchorId,
          ],
        );
        return {
          outcome: "anchored",
          anchorId,
          firstSequence,
          anchorSequence,
          selectedRuns: runs.length,
          backfilledEntries,
          gapItems,
        } as const;
      },
      { isolationLevel: "SERIALIZABLE" },
    );
  }
}

export class PgThreadContinuityMetrics implements ThreadContinuityMetricsPort {
  constructor(private readonly pool: Pool) {}

  async record(input: Parameters<ThreadContinuityMetricsPort["record"]>[0]): Promise<void> {
    if (
      !Number.isFinite(input.value) ||
      input.value < 0 ||
      Buffer.byteLength(input.observationId, "utf8") < 8 ||
      Buffer.byteLength(input.observationId, "utf8") > 512 ||
      (input.outcome !== undefined && Buffer.byteLength(input.outcome, "utf8") > 64) ||
      (input.reason !== undefined && Buffer.byteLength(input.reason, "utf8") > 64)
    ) {
      throw new TypeError("Thread continuity metric 无效");
    }
    await withTenantTransaction(this.pool, { tenantId: input.tenantId }, async (client) => {
      await client.query(
        `INSERT INTO thread_continuity_metric_observations(
           tenant_id,observation_id,thread_id,run_id,metric_name,value,unit,path,outcome,reason
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (tenant_id,observation_id) DO NOTHING`,
        [
          input.tenantId,
          input.observationId,
          input.threadId,
          input.runId ?? null,
          input.metricName,
          input.value,
          input.unit,
          input.path ?? null,
          input.outcome ?? null,
          input.reason ?? null,
        ],
      );
    });
  }
}

export class PgThreadContinuityReadRepository implements ThreadContinuityReadPort {
  constructor(private readonly pool: Pool) {}

  async getStatus(
    input: Parameters<ThreadContinuityReadPort["getStatus"]>[0],
  ): ReturnType<ThreadContinuityReadPort["getStatus"]> {
    return withTenantTransaction(
      this.pool,
      input.scope,
      async (client) => {
        const authorized = await client.query(
          `SELECT 1 FROM threads thread JOIN memberships membership
             ON membership.tenant_id=thread.tenant_id AND membership.user_id=$2
            AND membership.status='active'
            WHERE thread.tenant_id=$1 AND thread.id=$3`,
          [input.scope.tenantId, input.scope.userId, input.threadId],
        );
        if (authorized.rowCount !== 1) return { outcome: "not_found" } as const;
        const result = await client.query<{
          readonly rollout_source: ThreadContinuityStatusView["boundary"] | null;
          readonly read_enabled: boolean;
          readonly anchor_id: string | null;
          readonly context_sequence: string | null;
          readonly window_number: string | null;
          readonly queue_depth: string;
          readonly sandbox_state: NonNullable<ThreadContinuityStatusView["sandboxState"]> | null;
        }>(
          `SELECT profile.rollout_source,
                  COALESCE(policy.v2_read_enabled AND profile.rollout_selected AND
                    (profile.rollout_source<>'legacy_anchor' OR policy.legacy_anchor_read_enabled),false)
                    AS read_enabled,
                  profile.anchor_id,head.context_through_sequence::text AS context_sequence,
                  stream.current_window_number::text AS window_number,
                  (SELECT count(*)::text FROM thread_follow_up_queue queue
                    WHERE queue.tenant_id=$1 AND queue.thread_id=$2
                      AND queue.state IN ('queued','active')) AS queue_depth,
                  (SELECT session.state FROM thread_sandbox_sessions session
                    WHERE session.tenant_id=$1 AND session.thread_id=$2
                    ORDER BY session.generation DESC LIMIT 1) AS sandbox_state
             FROM thread_execution_heads head
             JOIN thread_context_streams stream
               ON stream.tenant_id=head.tenant_id AND stream.thread_id=head.thread_id
             LEFT JOIN thread_continuity_profiles profile
               ON profile.tenant_id=head.tenant_id AND profile.thread_id=head.thread_id
             LEFT JOIN tenant_thread_continuity_policies policy
               ON policy.tenant_id=head.tenant_id
            WHERE head.tenant_id=$1 AND head.thread_id=$2`,
          [input.scope.tenantId, input.threadId],
        );
        const row = result.rows[0];
        if (row === undefined) return { outcome: "not_found" } as const;
        return {
          outcome: "found",
          status: {
            boundary: row.rollout_source ?? "unmigrated",
            readMode: row.read_enabled ? "v2" : "legacy",
            anchorState: row.anchor_id === null ? "none" : "completed",
            queueDepth: Number(row.queue_depth),
            contextSequence: row.context_sequence === null ? 0 : Number(row.context_sequence),
            compactionWindow: row.window_number === null ? 0 : Number(row.window_number),
            ...(row.sandbox_state === null ? {} : { sandboxState: row.sandbox_state }),
          },
        } as const;
      },
      { readOnly: true, isolationLevel: "REPEATABLE READ" },
    );
  }
}

async function readAnchor(
  client: PoolClient,
  tenantId: string,
  threadId: string,
): Promise<LegacyAnchorSnapshot | undefined> {
  const result = await client.query<{
    readonly anchor_id: string;
    readonly first_context_sequence: string;
    readonly anchor_context_sequence: string;
    readonly selected_runs: number;
    readonly backfilled_entries: number;
    readonly gap_items: number;
  }>(
    `SELECT anchor_id,first_context_sequence::text,anchor_context_sequence::text,
            selected_runs,backfilled_entries,gap_items
       FROM thread_context_legacy_anchors WHERE tenant_id=$1 AND thread_id=$2`,
    [tenantId, threadId],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        anchorId: row.anchor_id,
        firstSequence: safeSequence(row.first_context_sequence),
        anchorSequence: safeSequence(row.anchor_context_sequence),
        selectedRuns: row.selected_runs,
        backfilledEntries: row.backfilled_entries,
        gapItems: row.gap_items,
      };
}

function legacyWorkspaceEntry(anchorId: string, run: LegacyRunRow): PendingEntry | undefined {
  if (run.result_outcome === "unchanged") {
    const body = {
      revisionId: run.result_revision_id,
      source: "run_workspace_results",
    } as const;
    return {
      entryId: `${anchorId}:${run.run_id}:workspace`,
      runId: run.run_id,
      kind: "workspace_unchanged",
      body,
      occurredAt: run.result_committed_at ?? run.run_updated_at,
      audit: {
        sourceRunId: run.run_id,
        evidenceKind: "workspace_result",
        outcome: "backfilled",
        sourceDigest: digestCanonical(body),
      },
    };
  }
  if (run.result_outcome === "failed_before_commit") return undefined;
  const revisionId = run.result_revision_id ?? run.revision_id;
  const manifestDigest = run.result_manifest_digest ?? run.revision_digest;
  if (revisionId === null || manifestDigest === null) return undefined;
  const body = {
    revisionId,
    manifestDigest,
    source: run.result_revision_id === null ? "workspace_revisions" : "run_workspace_results",
  } as const;
  return {
    entryId: `${anchorId}:${run.run_id}:workspace`,
    runId: run.run_id,
    kind: "workspace_committed",
    body,
    occurredAt: run.result_committed_at ?? run.revision_created_at ?? run.run_updated_at,
    audit: {
      sourceRunId: run.run_id,
      evidenceKind: "workspace_result",
      outcome: "backfilled",
      sourceDigest: digestCanonical(body),
    },
  };
}

async function insertLegacyEntry(
  client: PoolClient,
  tenantId: string,
  threadId: string,
  sequence: number,
  entry: PendingEntry,
): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(entry.body), "utf8");
  if (encoded.byteLength > 2 * 1024 * 1024) throw new TypeError("legacy context body 过大");
  await client.query(
    `INSERT INTO thread_context_entries(
       tenant_id,thread_id,sequence,entry_id,run_id,kind,body_inline,body_sha256,body_size,occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
    [
      tenantId,
      threadId,
      sequence,
      entry.entryId,
      entry.runId ?? null,
      entry.kind,
      encoded.toString("utf8"),
      digestCanonical(entry.body),
      encoded.byteLength,
      entry.occurredAt,
    ],
  );
}

function safeSequence(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new TypeError("Thread sequence 无效");
  return parsed;
}
