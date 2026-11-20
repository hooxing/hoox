import type {
  ExplicitSkillInvocation,
  RunSkillSnapshot,
  RunSkillSnapshotItem,
  SkillContentStore,
  SkillExecutionBinding,
  SkillInvocationFailureCode,
  SkillInvocationTarget,
  SkillPackageFile,
  SkillRuntimeRepository,
} from "@hoox/skill";
import { assertRunSkillSnapshot, digestRunSkillSnapshot, SkillRuntimeError } from "@hoox/skill";
import type { Pool, PoolClient } from "pg";
import { assertBlobRef, type BlobStore, type StableBlobRef } from "./blob-store.js";
import { PersistenceError } from "./errors.js";
import { withTenantTransaction } from "./postgres.js";

interface SnapshotRow {
  readonly source: RunSkillSnapshotItem["source"];
  readonly invocation_name: string;
  readonly canonical_key: string;
  readonly skill_id: string;
  readonly skill_version: string;
  readonly description: string;
  readonly entrypoint_digest: string;
  readonly package_digest: string;
  readonly package_blob_ref: string;
  readonly skill_status: string;
  readonly version_status: string;
  readonly entrypoint_file_digest: string | null;
  readonly entrypoint_media_type: string | null;
  readonly entrypoint_size_bytes: string | null;
  readonly entrypoint_blob_ref: string | null;
}

export class SkillSnapshotUnavailableError extends Error {
  constructor() {
    super("SKILL_NOT_AVAILABLE");
    this.name = "SkillSnapshotUnavailableError";
  }
}

class AgentSkillSnapshotUnavailableError extends PersistenceError {
  constructor() {
    super("AGENT_REVISION_UNAVAILABLE", "Agent 自带的精确 Skill 版本不可用");
  }
}

export async function readRunSkillSnapshot(
  client: PoolClient,
  tenantId: string,
  runId: string,
): Promise<RunSkillSnapshot> {
  const snapshot = await client.query<{
    readonly snapshot_digest: string;
    readonly explicit_invocation_name: string | null;
    readonly explicit_args: string | null;
  }>(
    `SELECT snapshot_digest,explicit_invocation_name,explicit_args
       FROM run_skill_snapshots WHERE tenant_id=$1 AND run_id=$2`,
    [tenantId, runId],
  );
  const row = snapshot.rows[0];
  if (row === undefined) {
    // 迁移前 Run 没有发起用户快照，只能保持固定空目录，不能反查当前安装。
    return Object.freeze({
      schemaVersion: 1,
      digest: digestRunSkillSnapshot({ items: [] }),
      items: Object.freeze([]),
    });
  }
  const items = await client.query<{
    readonly source: RunSkillSnapshotItem["source"];
    readonly invocation_name: string;
    readonly canonical_key: string;
    readonly skill_version: string;
    readonly description: string;
    readonly entrypoint_digest: string;
    readonly package_digest: string;
  }>(
    `SELECT source,invocation_name,canonical_key,skill_version,description,entrypoint_digest,package_digest
       FROM run_skill_snapshot_items
      WHERE tenant_id=$1 AND run_id=$2 ORDER BY ordinal`,
    [tenantId, runId],
  );
  return Object.freeze({
    schemaVersion: 1,
    digest: row.snapshot_digest,
    items: Object.freeze(
      items.rows.map((item) =>
        Object.freeze({
          source: item.source,
          invocationName: item.invocation_name,
          canonicalKey: item.canonical_key,
          skillVersion: item.skill_version,
          description: item.description,
          entrypointDigest: item.entrypoint_digest,
          packageDigest: item.package_digest,
        }),
      ),
    ),
    ...(row.explicit_invocation_name === null || row.explicit_args === null
      ? {}
      : {
          explicitInvocation: Object.freeze({
            invocationName: row.explicit_invocation_name,
            args: row.explicit_args,
          }),
        }),
  });
}

/** 调用方必须在创建 Run（或预留 fallback Run 身份）的同一个事务中调用。 */
export async function createRunSkillSnapshot(
  client: PoolClient,
  input: {
    readonly tenantId: string;
    readonly runId: string;
    readonly userId: string;
    readonly explicitInvocation?: ExplicitSkillInvocation;
    readonly includeTenantSkills?: boolean;
    readonly agentSkillVersions?: readonly { readonly skillId: string; readonly version: string }[];
  },
): Promise<void> {
  const agentVersions = input.agentSkillVersions ?? [];
  // 在同一个读视图按调用名排除被覆盖的安装，再校验实际生效的目录。
  const { rows } = await client.query<SnapshotRow>(
    `WITH agent_skills AS (
       SELECT skill.id AS skill_id,ref.skill_version,skill.canonical_key AS invocation_name
         FROM unnest($2::text[],$3::text[]) AS ref(skill_id,skill_version)
         JOIN skills skill ON skill.id=ref.skill_id
     ), candidates AS (
       SELECT skill_id,skill_version,invocation_name,'agent' AS source FROM agent_skills
       UNION ALL
       SELECT installation.skill_id,installation.skill_version,installation.invocation_name,'tenant'
         FROM tenant_skill_installations installation
        WHERE installation.tenant_id=$1 AND installation.status='enabled' AND $4::boolean
          AND NOT EXISTS (
            SELECT 1 FROM agent_skills WHERE invocation_name=installation.invocation_name
          )
     )
     SELECT candidate.source,candidate.invocation_name,skill.canonical_key,skill.id AS skill_id,
            candidate.skill_version,version.description,version.entrypoint_digest,
            version.package_digest,version.package_blob_ref,
            skill.status AS skill_status,version.status AS version_status,
            entrypoint.content_digest AS entrypoint_file_digest,
            entrypoint.media_type AS entrypoint_media_type,
            entrypoint.size_bytes::text AS entrypoint_size_bytes,
            entrypoint.blob_ref AS entrypoint_blob_ref
       FROM candidates candidate
       JOIN skills skill ON skill.id=candidate.skill_id
       JOIN skill_versions version
         ON version.skill_id=candidate.skill_id AND version.version=candidate.skill_version
       LEFT JOIN skill_version_files entrypoint
         ON entrypoint.skill_id=version.skill_id
        AND entrypoint.skill_version=version.version
        AND entrypoint.normalized_path=version.entrypoint_path
      ORDER BY candidate.invocation_name COLLATE "C"`,
    [
      input.tenantId,
      agentVersions.map((ref) => ref.skillId),
      agentVersions.map((ref) => ref.version),
      input.includeTenantSkills !== false,
    ],
  );
  const agentRows = rows.filter((row) => row.source === "agent");
  if (agentRows.length !== agentVersions.length) throw new AgentSkillSnapshotUnavailableError();
  try {
    if (agentRows.length > 0) {
      // 重复自带调用名没有裁决顺序，不允许静默选择某个精确引用。
      snapshotDigestFor(agentRows);
    }
  } catch (error) {
    if (error instanceof SkillSnapshotUnavailableError)
      throw new AgentSkillSnapshotUnavailableError();
    throw error;
  }
  const snapshotDigest = snapshotDigestFor(rows, input.explicitInvocation);
  const inserted = await client.query(
    `INSERT INTO run_skill_snapshots(
       tenant_id,run_id,user_id,schema_version,snapshot_digest,
       explicit_invocation_name,explicit_args
     ) VALUES ($1,$2,$3,1,$4,$5,$6)
     ON CONFLICT (tenant_id,run_id) DO NOTHING`,
    [
      input.tenantId,
      input.runId,
      input.userId,
      snapshotDigest,
      input.explicitInvocation?.invocationName ?? null,
      input.explicitInvocation?.args ?? null,
    ],
  );
  if (inserted.rowCount === 0) {
    const replay = await client.query<{
      readonly user_id: string;
      readonly snapshot_digest: string;
      readonly explicit_invocation_name: string | null;
      readonly explicit_args: string | null;
    }>(
      `SELECT user_id,snapshot_digest,explicit_invocation_name,explicit_args
         FROM run_skill_snapshots WHERE tenant_id=$1 AND run_id=$2`,
      [input.tenantId, input.runId],
    );
    const row = replay.rows[0];
    if (
      row?.user_id !== input.userId ||
      row.snapshot_digest !== snapshotDigest ||
      (row.explicit_invocation_name ?? undefined) !== input.explicitInvocation?.invocationName ||
      (row.explicit_args ?? undefined) !== input.explicitInvocation?.args
    ) {
      throw new SkillSnapshotUnavailableError();
    }
    return;
  }
  for (const [index, row] of rows.entries()) {
    await client.query(
      `INSERT INTO run_skill_snapshot_items(
         tenant_id,run_id,ordinal,invocation_name,canonical_key,skill_id,skill_version,
         description,entrypoint_digest,package_digest,source
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.tenantId,
        input.runId,
        index + 1,
        row.invocation_name,
        row.canonical_key,
        row.skill_id,
        row.skill_version,
        row.description,
        row.entrypoint_digest,
        row.package_digest,
        row.source,
      ],
    );
  }
}

function snapshotDigestFor(
  rows: readonly SnapshotRow[],
  explicitInvocation?: ExplicitSkillInvocation,
): string {
  const items = rows.map((row): RunSkillSnapshotItem => {
    const entrypointSize = Number(row.entrypoint_size_bytes);
    if (
      row.skill_status !== "active" ||
      row.version_status !== "available" ||
      row.entrypoint_file_digest !== row.entrypoint_digest ||
      row.entrypoint_blob_ref === null ||
      !Number.isSafeInteger(entrypointSize) ||
      entrypointSize < 1 ||
      entrypointSize > 64 * 1024 ||
      (row.source === "agent" &&
        (row.entrypoint_media_type?.split(";", 1)[0]?.trim().toLowerCase() !== "text/markdown" ||
          !matchesSkillBlobRef(row.entrypoint_blob_ref, row.entrypoint_digest, entrypointSize) ||
          !matchesSkillBlobRef(row.package_blob_ref, row.package_digest)))
    ) {
      throw new SkillSnapshotUnavailableError();
    }
    return {
      source: row.source,
      invocationName: row.invocation_name,
      canonicalKey: row.canonical_key,
      skillVersion: row.skill_version,
      description: row.description,
      entrypointDigest: row.entrypoint_digest,
      packageDigest: row.package_digest,
    };
  });
  const content = { items, ...(explicitInvocation === undefined ? {} : { explicitInvocation }) };
  const digest = digestRunSkillSnapshot(content);
  try {
    assertRunSkillSnapshot({ schemaVersion: 1, digest, ...content });
  } catch {
    throw new SkillSnapshotUnavailableError();
  }
  return digest;
}

function matchesSkillBlobRef(value: string, digest: string, size?: number): boolean {
  try {
    const ref = parseStableSkillBlobRef(value);
    assertBlobRef({ tenantId: ref.tenantId }, ref);
    return ref.sha256 === digest && (size === undefined ? ref.size > 0 : ref.size === size);
  } catch {
    return false;
  }
}

export class PgSkillRuntimeRepository implements SkillRuntimeRepository {
  constructor(private readonly pool: Pool) {}

  async beginInvocation(
    input: Parameters<SkillRuntimeRepository["beginInvocation"]>[0],
  ): Promise<SkillInvocationTarget> {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.binding.tenantId },
      async (client) => {
        await requireActiveFence(client, input.binding);
        const target = await readTarget(client, input.binding, input.invocationName);
        const invocationId =
          input.source === "explicit" ? "explicit" : `tool:${String(input.callId)}`;
        const existing = await client.query<{
          readonly source: string;
          readonly call_id: string | null;
          readonly invocation_name: string;
          readonly skill_version: string;
          readonly args_digest: string;
          readonly status: string;
          readonly failure_code: SkillInvocationFailureCode | null;
        }>(
          `SELECT source,call_id,invocation_name,skill_version,args_digest,status,failure_code
           FROM skill_invocations
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 AND invocation_id=$4
          FOR UPDATE`,
          [input.binding.tenantId, input.binding.runId, input.binding.attemptId, invocationId],
        );
        const replay = existing.rows[0];
        if (replay !== undefined) {
          if (
            replay.source !== input.source ||
            (replay.call_id ?? undefined) !== input.callId ||
            replay.invocation_name !== input.invocationName ||
            replay.skill_version !== target.skillVersion ||
            replay.args_digest !== input.argsDigest
          ) {
            throw new SkillRuntimeError("SKILL_PROTOCOL");
          }
          if (replay.status === "failed") {
            throw new SkillRuntimeError(replay.failure_code ?? "SKILL_PROTOCOL");
          }
          return { ...target, invocationId };
        }
        const count = await client.query<{ readonly count: string }>(
          `SELECT count(*)::text AS count FROM skill_invocations
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3`,
          [input.binding.tenantId, input.binding.runId, input.binding.attemptId],
        );
        if (Number(count.rows[0]?.count ?? "0") >= 8) {
          throw new SkillRuntimeError("SKILL_CONTEXT_LIMIT");
        }
        await client.query(
          `INSERT INTO skill_invocations(
           tenant_id,run_id,attempt_id,invocation_id,call_id,source,invocation_name,
           skill_version,args_digest,status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'loading')`,
          [
            input.binding.tenantId,
            input.binding.runId,
            input.binding.attemptId,
            invocationId,
            input.callId ?? null,
            input.source,
            input.invocationName,
            target.skillVersion,
            input.argsDigest,
          ],
        );
        return { ...target, invocationId };
      },
    );
  }

  async completeInvocation(
    input: Parameters<SkillRuntimeRepository["completeInvocation"]>[0],
  ): Promise<void> {
    await withTenantTransaction(this.pool, { tenantId: input.binding.tenantId }, async (client) => {
      await requireActiveFence(client, input.binding);
      const result = await client.query<{
        readonly status: string;
        readonly instruction_digest: string | null;
        readonly failure_code: string | null;
      }>(
        `UPDATE skill_invocations
            SET status=$5,instruction_digest=$6,failure_code=$7,updated_at=clock_timestamp()
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 AND invocation_id=$4
            AND status='loading'
          RETURNING status,instruction_digest,failure_code`,
        [
          input.binding.tenantId,
          input.binding.runId,
          input.binding.attemptId,
          input.invocationId,
          input.status,
          input.status === "loaded" ? input.instructionDigest : null,
          input.status === "failed" ? input.failureCode : null,
        ],
      );
      if (result.rowCount === 1) return;
      const replay = await client.query<{
        readonly status: string;
        readonly instruction_digest: string | null;
        readonly failure_code: string | null;
      }>(
        `SELECT status,instruction_digest,failure_code FROM skill_invocations
          WHERE tenant_id=$1 AND run_id=$2 AND attempt_id=$3 AND invocation_id=$4`,
        [input.binding.tenantId, input.binding.runId, input.binding.attemptId, input.invocationId],
      );
      const row = replay.rows[0];
      if (
        row?.status !== input.status ||
        (row.instruction_digest ?? undefined) !==
          (input.status === "loaded" ? input.instructionDigest : undefined) ||
        (row.failure_code ?? undefined) !==
          (input.status === "failed" ? input.failureCode : undefined)
      ) {
        throw new SkillRuntimeError("SKILL_PROTOCOL");
      }
    });
  }

  async listLoadedPackages(
    input: Parameters<SkillRuntimeRepository["listLoadedPackages"]>[0],
  ): Promise<readonly SkillInvocationTarget[]> {
    return withTenantTransaction(
      this.pool,
      { tenantId: input.binding.tenantId },
      async (client) => {
        await requireActiveFence(client, input.binding);
        const names = await client.query<{ readonly invocation_name: string }>(
          `SELECT invocation_name FROM skill_invocations
            WHERE tenant_id=$1 AND run_id=$2 AND status='loaded'
            GROUP BY invocation_name
            ORDER BY invocation_name COLLATE "C"`,
          [input.binding.tenantId, input.binding.runId],
        );
        return await Promise.all(
          names.rows.map(async (row) => ({
            ...(await readTarget(client, input.binding, row.invocation_name)),
            invocationId: `materialize:${row.invocation_name}`,
          })),
        );
      },
      { readOnly: true },
    );
  }
}

export class BlobSkillContentStore implements SkillContentStore {
  constructor(private readonly blobs: BlobStore) {}

  async read(input: Parameters<SkillContentStore["read"]>[0]): Promise<Uint8Array> {
    const reference = parseStableSkillBlobRef(input.blobRef);
    if (
      reference.sha256 !== input.expectedDigest ||
      reference.size !== input.expectedSizeBytes ||
      reference.purpose !== "skill"
    ) {
      throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
    }
    try {
      return await this.blobs.getBytes({ tenantId: reference.tenantId }, reference);
    } catch {
      throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
    }
  }
}

async function readTarget(
  client: PoolClient,
  binding: SkillExecutionBinding,
  invocationName: string,
): Promise<Omit<SkillInvocationTarget, "invocationId">> {
  const item = await client.query<{
    readonly invocation_name: string;
    readonly canonical_key: string;
    readonly skill_id: string;
    readonly skill_version: string;
    readonly entrypoint_digest: string;
    readonly package_digest: string;
    readonly skill_status: string;
    readonly version_status: string;
  }>(
    `SELECT item.invocation_name,item.canonical_key,item.skill_id,item.skill_version,item.entrypoint_digest,
            item.package_digest,skill.status AS skill_status,version.status AS version_status
       FROM run_skill_snapshot_items item
       JOIN skills skill ON skill.id=item.skill_id
       JOIN skill_versions version
         ON version.skill_id=item.skill_id AND version.version=item.skill_version
      WHERE item.tenant_id=$1 AND item.run_id=$2 AND item.invocation_name=$3`,
    [binding.tenantId, binding.runId, invocationName],
  );
  const row = item.rows[0];
  if (row === undefined) throw new SkillRuntimeError("SKILL_NOT_INSTALLED");
  if (row.skill_status !== "active" || row.version_status !== "available") {
    throw new SkillRuntimeError("SKILL_REVOKED");
  }
  const files = await client.query<{
    readonly normalized_path: string;
    readonly media_type: string;
    readonly size_bytes: string;
    readonly content_digest: string;
    readonly blob_ref: string;
  }>(
    `SELECT normalized_path,media_type,size_bytes::text,content_digest,blob_ref
       FROM skill_version_files
      WHERE skill_id=$1 AND skill_version=$2 ORDER BY normalized_path COLLATE "C"`,
    [row.skill_id, row.skill_version],
  );
  const mappedFiles: SkillPackageFile[] = files.rows.map((file) => ({
    path: file.normalized_path,
    mediaType: file.media_type,
    sizeBytes: Number(file.size_bytes),
    contentDigest: file.content_digest,
    blobRef: file.blob_ref,
  }));
  const entrypoint = mappedFiles.find((file) => file.path === "SKILL.md");
  if (
    entrypoint === undefined ||
    entrypoint.contentDigest !== row.entrypoint_digest ||
    !Number.isSafeInteger(entrypoint.sizeBytes)
  ) {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
  return {
    invocationName: row.invocation_name,
    canonicalKey: row.canonical_key,
    skillVersion: row.skill_version,
    entrypointDigest: row.entrypoint_digest,
    entrypointSizeBytes: entrypoint.sizeBytes,
    entrypointBlobRef: entrypoint.blobRef,
    packageDigest: row.package_digest,
    files: mappedFiles,
  };
}

async function requireActiveFence(
  client: PoolClient,
  binding: SkillExecutionBinding,
): Promise<void> {
  const result = await client.query(
    `SELECT 1
       FROM execution_attempts attempt
       JOIN run_claims claim
         ON claim.tenant_id=attempt.tenant_id AND claim.attempt_id=attempt.attempt_id
       JOIN execution_workspace_fences fence
         ON fence.tenant_id=attempt.tenant_id AND fence.attempt_id=attempt.attempt_id
       JOIN workspace_write_leases lease
         ON lease.tenant_id=attempt.tenant_id AND lease.workspace_id=attempt.workspace_id
        AND lease.root_run_id=attempt.root_run_id AND lease.epoch=fence.lease_epoch
      WHERE attempt.tenant_id=$1 AND attempt.run_id=$2 AND attempt.attempt_id=$3
        AND attempt.thread_id=$4 AND attempt.workspace_id=$5 AND attempt.root_run_id=$6
        AND attempt.base_revision_id IS NOT DISTINCT FROM $7
        AND attempt.status IN ('claimed','running','finalizing')
        AND claim.claim_token=$8 AND claim.claim_epoch=$9 AND claim.released_at IS NULL
        AND claim.expires_at > clock_timestamp()
        AND fence.root_run_id=$10 AND fence.lease_epoch=$11
        AND lease.expires_at > clock_timestamp()`,
    [
      binding.tenantId,
      binding.runId,
      binding.attemptId,
      binding.threadId,
      binding.workspaceId,
      binding.rootRunId,
      binding.baseRevisionId ?? null,
      binding.runClaimToken,
      binding.runClaimEpoch,
      binding.workspaceLeaseRootRunId,
      binding.workspaceLeaseEpoch,
    ],
  );
  if (result.rowCount !== 1) throw new SkillRuntimeError("SKILL_PROTOCOL");
}

function parseStableSkillBlobRef(value: string): StableBlobRef {
  try {
    const parsed = JSON.parse(value) as StableBlobRef;
    if (
      parsed.kind !== "stable" ||
      typeof parsed.tenantId !== "string" ||
      parsed.purpose !== "skill" ||
      !/^[0-9a-f]{64}$/u.test(parsed.sha256) ||
      !Number.isSafeInteger(parsed.size) ||
      parsed.size < 0 ||
      typeof parsed.mediaType !== "string" ||
      typeof parsed.incarnationId !== "string" ||
      typeof parsed.physicalObjectKey !== "string"
    ) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
}
