import { createHash, randomUUID } from "node:crypto";
import { isoTimestamp, type UserId, userId } from "@hoox/domain";
import type {
  SkillNamespace,
  SkillPublicationAuthorizationPort,
  SkillPublicationCommandResult,
  SkillPublicationCreateResult,
  SkillPublicationFileDescriptor,
  SkillPublicationPage,
  SkillPublicationPort,
  SkillPublicationRole,
  SkillPublicationStatus,
  SkillPublicationSubmission,
  ValidatedSkillPublicationPackage,
} from "@hoox/skill";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { mapPersistenceError, PersistenceError } from "./errors.js";
import { TransactionCommitUnknownError, withTransaction } from "./postgres.js";
import type {
  StableSkillPublicationObjectStore,
  StoredSkillPublicationFile,
  StoredSkillPublicationPackage,
} from "./skill-publication-object-store.js";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

interface OperatorRow extends QueryResultRow {
  readonly role: SkillPublicationRole;
}

interface CommandRow extends QueryResultRow {
  readonly operation: PublicationOperation;
  readonly request_digest: string;
  readonly submission_id: string;
  readonly result_version_token: string;
}

interface SubmissionRow extends QueryResultRow {
  readonly submission_id: string;
  readonly canonical_key: string;
  readonly display_name: string;
  readonly publisher: string;
  readonly skill_version: string;
  readonly description: string;
  readonly compatibility: string;
  readonly source_url: string;
  readonly source_revision: string;
  readonly license_spdx: string;
  readonly status: SkillPublicationStatus;
  readonly security_status: "restricted";
  readonly package_digest: string;
  readonly entrypoint_digest: string;
  readonly package_blob_ref: string;
  readonly file_count: number;
  readonly total_bytes: string;
  readonly version_token: string;
  readonly created_by: string;
  readonly reviewed_by: string | null;
  readonly rejection_reason: string | null;
  readonly published_skill_id: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface FileRow extends QueryResultRow {
  readonly submission_id: string;
  readonly normalized_path: string;
  readonly media_type: string;
  readonly size_bytes: string;
  readonly content_digest: string;
  readonly blob_ref: string;
}

interface SubmissionSnapshot {
  readonly row: SubmissionRow;
  readonly files: readonly FileRow[];
  readonly currentPublished?: Readonly<{ submissionId: string; versionToken: number }>;
}

type PublicationOperation = "create" | "submit" | "approve" | "reject" | "publish" | "revoke";

const submissionProjection = `
  submission_id,canonical_key,display_name,publisher,skill_version,description,compatibility,
  source_url,source_revision,license_spdx,status,security_status,package_digest,entrypoint_digest,
  package_blob_ref,file_count,total_bytes::text,version_token::text,created_by,reviewed_by,
  rejection_reason,published_skill_id,created_at,updated_at`;

/** 独立发布连接仍必须通过事务级 user_id 才能看到自己的平台运营角色。 */
export class PgSkillPublicationAuthorization implements SkillPublicationAuthorizationPort {
  constructor(private readonly pool: Pool) {}

  async resolveRole(actorUserId: UserId): Promise<SkillPublicationRole | undefined> {
    const actor = snapshotActor(actorUserId);
    try {
      return await withActorTransaction(
        this.pool,
        actor,
        async (client) => readActiveRole(client, actor),
        true,
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, "读取 Skill 发布角色");
    }
  }

  async hasNamespaceAccess(actorUserId: UserId, namespace: string): Promise<boolean> {
    const actor = snapshotActor(actorUserId);
    try {
      return await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          const role = await readActiveRole(client, actor);
          if (role === "admin") return true;
          const result = await client.query(
            `SELECT 1 FROM skill_namespace_publishers
              WHERE namespace=$1 AND user_id=$2 AND revoked_at IS NULL`,
            [namespace, actor],
          );
          return result.rowCount === 1;
        },
        true,
      );
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, "读取 Skill 命名空间授权");
    }
  }

  async listAccessibleNamespaces(actorUserId: UserId): Promise<readonly string[]> {
    const actor = snapshotActor(actorUserId);
    try {
      return await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          await requireRole(client, actor, ["publisher", "reviewer", "admin"]);
          const result = await client.query<{ namespace: string }>(
            "SELECT namespace FROM skill_namespaces ORDER BY namespace",
          );
          return result.rows.map((row) => row.namespace);
        },
        true,
      );
    } catch (error) {
      throw mapPublicationError(error, "读取 Skill 发布命名空间");
    }
  }
}

/**
 * 管理发布事实与公开目录使用同一 PostgreSQL 事务。领域服务是第一道鉴权，本实现会再次读取
 * 当前 operator 行并执行角色、自审、CAS 与幂等约束，避免调用方绕过领域服务直接写库。
 */
export class PgSkillPublicationRepository implements SkillPublicationPort {
  constructor(
    private readonly pool: Pool,
    private readonly objects: StableSkillPublicationObjectStore,
  ) {}

  async listNamespaces(actorUserId: UserId): Promise<readonly SkillNamespace[]> {
    const actor = snapshotActor(actorUserId);
    try {
      return await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          await requireRole(client, actor, ["admin"]);
          const result = await client.query<{
            namespace: string;
            created_by: string;
            created_at: Date | string;
            user_id: string | null;
            granted_by: string | null;
            granted_at: Date | string | null;
          }>(
            `SELECT namespace.namespace,namespace.created_by,namespace.created_at,
                  grant_row.user_id,grant_row.granted_by,grant_row.granted_at
             FROM skill_namespaces namespace
             LEFT JOIN skill_namespace_publishers grant_row
               ON grant_row.namespace=namespace.namespace AND grant_row.revoked_at IS NULL
            ORDER BY namespace.namespace,grant_row.user_id`,
          );
          const namespaces = new Map<
            string,
            SkillNamespace & { publishers: SkillNamespace["publishers"][number][] }
          >();
          for (const row of result.rows) {
            let current = namespaces.get(row.namespace);
            if (current === undefined) {
              current = {
                namespace: row.namespace,
                createdBy: userId(row.created_by),
                createdAt: databaseTimestamp(row.created_at),
                publishers: [],
              };
              namespaces.set(row.namespace, current);
            }
            if (row.user_id !== null && row.granted_by !== null && row.granted_at !== null) {
              current.publishers.push({
                userId: userId(row.user_id),
                grantedBy: userId(row.granted_by),
                grantedAt: databaseTimestamp(row.granted_at),
              });
            }
          }
          return [...namespaces.values()];
        },
        true,
      );
    } catch (error) {
      throw mapPublicationError(error, "查询 Skill 命名空间");
    }
  }

  async createNamespace(actorUserId: UserId, namespace: string): Promise<void> {
    const actor = snapshotActor(actorUserId);
    try {
      await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          await requireRole(client, actor, ["admin"]);
          await lockKey(client, namespaceNameLock(namespace));
          const collision = await client.query(
            `SELECT 1 FROM skills WHERE position('.' in canonical_key)>0 AND split_part(canonical_key,'.',1)=$1
             UNION ALL
             SELECT 1 FROM skill_publication_submissions WHERE position('.' in canonical_key)>0 AND split_part(canonical_key,'.',1)=$1
             LIMIT 1`,
            [namespace],
          );
          if (collision.rowCount === 1) {
            throw new PersistenceError("CONFLICT", "命名空间前缀已被既有 Skill 使用");
          }
          await client.query("INSERT INTO skill_namespaces(namespace,created_by) VALUES($1,$2)", [
            namespace,
            actor,
          ]);
          await recordNamespaceAudit(client, namespace, actor, null, "create");
        },
        false,
      );
    } catch (error) {
      throw mapPublicationError(error, "创建 Skill 命名空间");
    }
  }

  async grantNamespace(
    actorUserId: UserId,
    namespace: string,
    publisherUserId: UserId,
  ): Promise<void> {
    const actor = snapshotActor(actorUserId);
    const publisher = snapshotActor(publisherUserId);
    try {
      await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          await requireRole(client, actor, ["admin"]);
          await lockKey(client, namespacePublisherLock(namespace, publisher));
          const grant = await client.query(
            `INSERT INTO skill_namespace_publishers(namespace,user_id,granted_by,granted_at,revoked_by,revoked_at)
           VALUES($1,$2,$3,clock_timestamp(),NULL,NULL)
           ON CONFLICT(namespace,user_id) DO UPDATE SET granted_by=EXCLUDED.granted_by,
             granted_at=clock_timestamp(),revoked_by=NULL,revoked_at=NULL
           WHERE skill_namespace_publishers.revoked_at IS NOT NULL`,
            [namespace, publisher, actor],
          );
          if (grant.rowCount === 1)
            await recordNamespaceAudit(client, namespace, actor, publisher, "grant");
        },
        false,
      );
    } catch (error) {
      throw mapPublicationError(error, "授予 Skill 命名空间");
    }
  }

  async revokeNamespace(
    actorUserId: UserId,
    namespace: string,
    publisherUserId: UserId,
  ): Promise<void> {
    const actor = snapshotActor(actorUserId);
    const publisher = snapshotActor(publisherUserId);
    try {
      await withActorTransaction(
        this.pool,
        actor,
        async (client) => {
          await requireRole(client, actor, ["admin"]);
          await lockKey(client, namespacePublisherLock(namespace, publisher));
          const result = await client.query(
            `UPDATE skill_namespace_publishers SET revoked_by=$3,revoked_at=clock_timestamp()
            WHERE namespace=$1 AND user_id=$2 AND revoked_at IS NULL`,
            [namespace, publisher, actor],
          );
          if (result.rowCount !== 1) throw new PersistenceError("CONFLICT", "Skill 授权不存在");
          await recordNamespaceAudit(client, namespace, actor, publisher, "revoke");
        },
        false,
      );
    } catch (error) {
      throw mapPublicationError(error, "撤销 Skill 命名空间授权");
    }
  }

  async list(input: Parameters<SkillPublicationPort["list"]>[0]): Promise<SkillPublicationPage> {
    const query = snapshotListInput(input);
    try {
      const snapshots = await withActorTransaction(
        this.pool,
        query.actorUserId,
        async (client) => {
          await requireRole(client, query.actorUserId, ["publisher", "reviewer", "admin"]);
          // 最新上传必须与完整历史比较后再分页，旧包不能占用页面或因游标截断重新出现。
          const rows = await client.query<SubmissionRow>(
            `SELECT ${submissionProjection}
               FROM skill_publication_submissions submission
              WHERE ($1::text IS NULL OR submission_id>$1)
                AND (NOT $3::boolean OR NOT EXISTS (
                  SELECT 1 FROM skill_publication_submissions newer
                   WHERE newer.canonical_key=submission.canonical_key
                     AND (newer.created_at,newer.submission_id)>(submission.created_at,submission.submission_id)
                ))
              ORDER BY submission_id ASC LIMIT $2`,
            [query.afterSubmissionId ?? null, query.limit + 1, query.latestOnly],
          );
          return readSnapshots(client, rows.rows);
        },
        true,
      );
      const hasMore = snapshots.length > query.limit;
      const selected = snapshots.slice(0, query.limit);
      const items = Object.freeze(
        await Promise.all(selected.map((snapshot) => this.hydrate(snapshot))),
      );
      const next = hasMore ? items.at(-1) : undefined;
      return Object.freeze({
        items,
        ...(next === undefined ? {} : { nextSubmissionId: next.submissionId }),
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, "查询 Skill 发布申请");
    }
  }

  async get(
    input: Parameters<SkillPublicationPort["get"]>[0],
  ): Promise<SkillPublicationSubmission | undefined> {
    const query = snapshotGetInput(input);
    try {
      const snapshot = await withActorTransaction(
        this.pool,
        query.actorUserId,
        async (client) => {
          await requireRole(client, query.actorUserId, ["publisher", "reviewer", "admin"]);
          return readSnapshot(client, query.submissionId);
        },
        true,
      );
      return snapshot === undefined ? undefined : this.hydrate(snapshot);
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, "读取 Skill 发布申请");
    }
  }

  async create(
    input: Parameters<SkillPublicationPort["create"]>[0],
  ): Promise<SkillPublicationCreateResult> {
    const command = snapshotCreateInput(input);
    let stored: StoredSkillPublicationPackage;
    try {
      // 内容寻址对象允许成为未引用对象；数据库冲突或 COMMIT UNKNOWN 时不能删除可能已被引用的对象。
      stored = await this.objects.publishPackage(command.package);
      const result = await withActorTransaction(
        this.pool,
        command.actorUserId,
        async (client) => {
          await requireRole(client, command.actorUserId, ["publisher", "admin"]);
          if ((await readActiveRole(client, command.actorUserId)) === "publisher") {
            const namespace = namespaceFromCanonicalKey(command.package.metadata.canonicalKey);
            await lockKey(client, namespacePublisherLock(namespace, command.actorUserId));
            if (!(await hasPublisherNamespace(client, command.actorUserId, namespace))) {
              return { outcome: "key_conflict" as const };
            }
          }
          const keyNamespace = namespaceFromCanonicalKey(command.package.metadata.canonicalKey);
          if (keyNamespace !== "") await lockKey(client, namespaceNameLock(keyNamespace));
          await lockCommand(client, command.actorUserId, command.idempotencyKey);
          await lockKey(client, `submission|${command.submissionId}`);
          await lockKey(
            client,
            `publication|${command.package.metadata.canonicalKey}|${command.package.metadata.version}`,
          );
          const replay = await readCommand(client, command.actorUserId, command.idempotencyKey);
          if (replay !== undefined) {
            if (replay.operation !== "create" || replay.request_digest !== command.requestDigest) {
              return { outcome: "key_conflict" as const };
            }
            const snapshot = await readSnapshot(client, replay.submission_id);
            if (snapshot === undefined) throw new TypeError("Skill 发布幂等事实缺少申请");
            return { outcome: "replayed" as const, snapshot };
          }
          if (await submissionIdExists(client, command.submissionId)) {
            return { outcome: "key_conflict" as const };
          }
          if (
            await publicationVersionExists(
              client,
              command.package.metadata.canonicalKey,
              command.package.metadata.version,
            )
          ) {
            return { outcome: "version_conflict" as const };
          }
          assertStoredPackage(command.package, stored);
          await insertSubmission(client, command, stored);
          await insertPublicationFiles(client, command.submissionId, stored.files);
          await recordAudit(client, {
            submissionId: command.submissionId,
            actorUserId: command.actorUserId,
            namespace: auditNamespaceFromCanonicalKey(command.package.metadata.canonicalKey),
            skillVersion: command.package.metadata.version,
            key: command.idempotencyKey,
            operation: "create",
            afterStatus: "draft",
            versionToken: 0,
          });
          await recordCommand(client, {
            actorUserId: command.actorUserId,
            key: command.idempotencyKey,
            operation: "create",
            requestDigest: command.requestDigest,
            submissionId: command.submissionId,
            versionToken: 0,
          });
          const snapshot = await readSnapshot(client, command.submissionId);
          if (snapshot === undefined) throw new TypeError("Skill 发布申请提交后不可见");
          return { outcome: "created" as const, snapshot };
        },
        false,
        "SERIALIZABLE",
      );
      if (result.outcome === "key_conflict" || result.outcome === "version_conflict") {
        return result;
      }
      return {
        outcome: result.outcome,
        submission: await this.hydrate(result.snapshot),
      };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, "创建 Skill 发布申请");
    }
  }

  submit(
    input: Parameters<SkillPublicationPort["submit"]>[0],
  ): Promise<SkillPublicationCommandResult> {
    return this.transition(snapshotTransitionInput(input), {
      operation: "submit",
      roles: ["publisher", "admin"],
      allowedStatuses: ["draft"],
      afterStatus: "submitted",
      enforceOwner: true,
    });
  }

  review(
    input: Parameters<SkillPublicationPort["review"]>[0],
  ): Promise<SkillPublicationCommandResult> {
    const command = snapshotReviewInput(input);
    return this.transition(command, {
      operation: command.decision === "approve" ? "approve" : "reject",
      roles: ["reviewer", "admin"],
      allowedStatuses: ["submitted"],
      afterStatus: command.decision === "approve" ? "approved" : "rejected",
      ...(command.reason === undefined ? {} : { rejectReason: command.reason }),
      forbidSelfReview: true,
    });
  }

  publish(
    input: Parameters<SkillPublicationPort["publish"]>[0],
  ): Promise<SkillPublicationCommandResult> {
    const command = snapshotPublishInput(input);
    return this.transition(command, {
      operation: "publish",
      roles: ["publisher", "admin"],
      // 管理员发布已通过包校验的内容；兼容历史待审和已批准数据，不制造审核事实。
      allowedStatuses: ["draft", "submitted", "approved"],
      afterStatus: "published",
      recommended: command.recommended,
    });
  }

  revoke(
    input: Parameters<SkillPublicationPort["revoke"]>[0],
  ): Promise<SkillPublicationCommandResult> {
    const command = snapshotRevokeInput(input);
    return this.transition(command, {
      operation: "revoke",
      roles: ["publisher", "admin"],
      allowedStatuses: ["published"],
      afterStatus: "revoked",
      ...(command.reason === undefined ? {} : { revokeReason: command.reason }),
    });
  }

  private async transition(
    command: TransitionCommand,
    plan: TransitionPlan,
  ): Promise<SkillPublicationCommandResult> {
    try {
      const result = await withActorTransaction(
        this.pool,
        command.actorUserId,
        async (client) => {
          const role = await requireRole(client, command.actorUserId, plan.roles);
          const prior = await readCommand(client, command.actorUserId, command.idempotencyKey);
          const candidateId = prior?.submission_id ?? command.submissionId;
          const candidate = await readSnapshot(client, candidateId);
          if (candidate === undefined) return { outcome: "not_found" as const };
          const namespace = namespaceFromCanonicalKey(candidate.row.canonical_key);
          if (role === "publisher") {
            await lockKey(client, namespacePublisherLock(namespace, command.actorUserId));
          }
          await lockCommand(client, command.actorUserId, command.idempotencyKey);
          if (
            role === "publisher" &&
            !(await hasPublisherNamespace(client, command.actorUserId, namespace))
          ) {
            return { outcome: "not_found" as const };
          }
          const replay = await readCommand(client, command.actorUserId, command.idempotencyKey);
          if (replay !== undefined) {
            if (
              replay.operation !== plan.operation ||
              replay.request_digest !== command.requestDigest ||
              replay.submission_id !== command.submissionId
            ) {
              return { outcome: "state_conflict" as const };
            }
            const snapshot = await readSnapshot(client, replay.submission_id);
            if (snapshot === undefined) throw new TypeError("Skill 发布幂等事实缺少申请");
            return { outcome: "replayed" as const, snapshot };
          }
          const current = await readSnapshot(client, command.submissionId, true);
          if (current === undefined) return { outcome: "not_found" as const };
          const versionToken = Number(current.row.version_token);
          if (versionToken !== command.expectedVersionToken) {
            return { outcome: "version_conflict" as const };
          }
          if (
            !plan.allowedStatuses.includes(current.row.status) ||
            (plan.enforceOwner === true &&
              role !== "admin" &&
              current.row.created_by !== command.actorUserId) ||
            (plan.forbidSelfReview === true &&
              role !== "admin" &&
              current.row.created_by === command.actorUserId)
          ) {
            return { outcome: "state_conflict" as const };
          }

          let publishedSkillId: string | undefined;
          if (plan.operation === "publish") {
            publishedSkillId = await publishCatalog(client, current, plan.recommended === true);
            if (publishedSkillId === undefined) return { outcome: "state_conflict" as const };
          } else if (plan.operation === "revoke") {
            if (!(await revokeCatalog(client, current))) {
              return { outcome: "state_conflict" as const };
            }
          }

          const nextVersion = versionToken + 1;
          const updated = await client.query(
            `UPDATE skill_publication_submissions
                SET status=$4,version_token=version_token+1,
                    reviewed_by=CASE
                      WHEN $5::boolean THEN $1
                      WHEN $4='submitted' THEN NULL
                      ELSE reviewed_by
                    END,
                    rejection_reason=CASE
                      WHEN $4='rejected' THEN $6
                      WHEN $4 IN ('submitted','approved') THEN NULL
                      ELSE rejection_reason
                    END,
                    published_skill_id=CASE WHEN $4='published' THEN $7 ELSE published_skill_id END,
                    updated_at=clock_timestamp()
              WHERE submission_id=$2 AND version_token=$3 AND status=$8`,
            [
              command.actorUserId,
              command.submissionId,
              command.expectedVersionToken,
              plan.afterStatus,
              plan.operation === "approve" || plan.operation === "reject",
              plan.rejectReason ?? null,
              publishedSkillId ?? null,
              current.row.status,
            ],
          );
          if (updated.rowCount !== 1) return { outcome: "version_conflict" as const };
          await recordAudit(client, {
            submissionId: command.submissionId,
            actorUserId: command.actorUserId,
            namespace: auditNamespaceFromCanonicalKey(current.row.canonical_key),
            skillVersion: current.row.skill_version,
            key: command.idempotencyKey,
            operation: plan.operation,
            beforeStatus: current.row.status,
            afterStatus: plan.afterStatus,
            ...(plan.rejectReason === undefined && plan.revokeReason === undefined
              ? {}
              : { reason: plan.rejectReason ?? plan.revokeReason }),
            versionToken: nextVersion,
          });
          await recordCommand(client, {
            actorUserId: command.actorUserId,
            key: command.idempotencyKey,
            operation: plan.operation,
            requestDigest: command.requestDigest,
            submissionId: command.submissionId,
            versionToken: nextVersion,
          });
          const snapshot = await readSnapshot(client, command.submissionId);
          if (snapshot === undefined) throw new TypeError("Skill 发布状态推进后不可见");
          return { outcome: "updated" as const, snapshot };
        },
        false,
      );
      if (
        result.outcome === "not_found" ||
        result.outcome === "version_conflict" ||
        result.outcome === "state_conflict"
      ) {
        return result;
      }
      return {
        outcome: result.outcome,
        submission: await this.hydrate(result.snapshot),
      };
    } catch (error) {
      if (error instanceof TypeError) throw error;
      throw mapPublicationError(error, `执行 Skill 发布${plan.operation}命令`);
    }
  }

  private async hydrate(snapshot: SubmissionSnapshot): Promise<SkillPublicationSubmission> {
    const entrypoint = snapshot.files.find((file) => file.normalized_path === "SKILL.md");
    if (entrypoint === undefined || entrypoint.content_digest !== snapshot.row.entrypoint_digest) {
      throw new TypeError("Skill 发布申请缺少规范入口文件");
    }
    const sizeBytes = safeInteger(entrypoint.size_bytes, "Skill 发布入口大小无效");
    const body = await this.objects.read({
      blobRef: entrypoint.blob_ref,
      expectedDigest: entrypoint.content_digest,
      expectedSizeBytes: sizeBytes,
    });
    let entrypointMarkdown: string;
    try {
      entrypointMarkdown = new TextDecoder("utf-8", { fatal: true }).decode(body);
    } catch {
      throw new TypeError("Skill 发布入口正文不是有效 UTF-8");
    }
    return mapSubmission(snapshot, entrypointMarkdown);
  }
}

interface TransitionCommand {
  readonly actorUserId: string;
  readonly submissionId: string;
  readonly expectedVersionToken: number;
  readonly idempotencyKey: string;
  readonly requestDigest: string;
}

interface TransitionPlan {
  readonly operation: Exclude<PublicationOperation, "create">;
  readonly roles: readonly SkillPublicationRole[];
  readonly allowedStatuses: readonly SkillPublicationStatus[];
  readonly afterStatus: SkillPublicationStatus;
  readonly enforceOwner?: boolean;
  readonly forbidSelfReview?: boolean;
  readonly rejectReason?: string;
  readonly recommended?: boolean;
  readonly revokeReason?: string;
}

async function withActorTransaction<T>(
  pool: Pool,
  actorUserId: string,
  operation: (client: PoolClient) => Promise<T>,
  readOnly: boolean,
  isolationLevel: "READ COMMITTED" | "SERIALIZABLE" = "READ COMMITTED",
): Promise<T> {
  return withTransaction(
    pool,
    async (client) => {
      await client.query("SELECT set_config('app.user_id', $1, true)", [actorUserId]);
      return operation(client);
    },
    { readOnly, isolationLevel },
  );
}

async function readActiveRole(
  client: PoolClient,
  actorUserId: string,
): Promise<SkillPublicationRole | undefined> {
  const result = await client.query<OperatorRow>(
    `SELECT role FROM platform_skill_operators
      WHERE user_id=$1 AND status='active'`,
    [actorUserId],
  );
  const role = result.rows[0]?.role;
  if (role === "admin" || role === "reviewer") return role;
  const namespaceGrant = await client.query(
    "SELECT 1 FROM skill_namespace_publishers WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1",
    [actorUserId],
  );
  return namespaceGrant.rowCount === 1 ? "publisher" : undefined;
}

async function hasPublisherNamespace(
  client: PoolClient,
  actorUserId: string,
  namespace: string,
): Promise<boolean> {
  const result = await client.query(
    "SELECT 1 FROM skill_namespace_publishers WHERE namespace=$1 AND user_id=$2 AND revoked_at IS NULL",
    [namespace, actorUserId],
  );
  return result.rowCount === 1;
}

function namespacePublisherLock(namespace: string, actorUserId: string): string {
  return `skill-namespace-publisher|${namespace}|${actorUserId}`;
}

function namespaceNameLock(namespace: string): string {
  return `skill-namespace-name|${namespace}`;
}

async function requireRole(
  client: PoolClient,
  actorUserId: string,
  allowed: readonly SkillPublicationRole[],
): Promise<SkillPublicationRole> {
  const role = await readActiveRole(client, actorUserId);
  if (role === undefined || !allowed.includes(role)) {
    throw new PersistenceError("CONSTRAINT_VIOLATION", "Skill 发布数据库二次鉴权失败");
  }
  return role;
}

async function lockCommand(client: PoolClient, actorUserId: string, key: string): Promise<void> {
  await lockKey(client, `skill-publication-command|${actorUserId}|${key}`);
}

async function lockKey(client: PoolClient, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function readCommand(
  client: PoolClient,
  actorUserId: string,
  key: string,
): Promise<CommandRow | undefined> {
  const result = await client.query<CommandRow>(
    `SELECT operation,request_digest,submission_id,result_version_token::text
       FROM skill_publication_commands
      WHERE actor_user_id=$1 AND idempotency_key=$2`,
    [actorUserId, key],
  );
  return result.rows[0];
}

async function readSnapshot(
  client: PoolClient,
  submissionId: string,
  forUpdate = false,
): Promise<SubmissionSnapshot | undefined> {
  const result = await client.query<SubmissionRow>(
    `SELECT ${submissionProjection}
       FROM skill_publication_submissions WHERE submission_id=$1${forUpdate ? " FOR UPDATE" : ""}`,
    [submissionId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return (await readSnapshots(client, [row]))[0];
}

async function readSnapshots(
  client: PoolClient,
  rows: readonly SubmissionRow[],
): Promise<readonly SubmissionSnapshot[]> {
  if (rows.length === 0) return [];
  const files = await readFiles(
    client,
    rows.map((row) => row.submission_id),
  );
  const currentPublications = await readCurrentPublications(
    client,
    rows.map((row) => row.canonical_key),
  );
  return rows.map((row) => {
    const currentPublished = currentPublications.get(row.canonical_key);
    return Object.freeze({
      row,
      files: Object.freeze(files.filter((file) => file.submission_id === row.submission_id)),
      ...(currentPublished === undefined ? {} : { currentPublished }),
    });
  });
}

async function readCurrentPublications(client: PoolClient, canonicalKeys: readonly string[]) {
  // 只有目录实际推荐且仍可用的包才是下架目标，不能把最近一次上传当成生效事实。
  const result = await client.query<{
    canonical_key: string;
    submission_id: string;
    version_token: string;
  }>(
    `SELECT skill.canonical_key,publication.submission_id,publication.version_token::text
       FROM skills skill
       JOIN skill_publication_submissions publication
         ON publication.published_skill_id=skill.id AND publication.skill_version=skill.recommended_version
       JOIN skill_versions version ON version.skill_id=skill.id AND version.version=skill.recommended_version
      WHERE skill.canonical_key=ANY($1::text[]) AND skill.status='active'
        AND version.status='available' AND publication.status='published'`,
    [canonicalKeys],
  );
  return new Map(
    result.rows.map((row) => [
      row.canonical_key,
      Object.freeze({
        submissionId: row.submission_id,
        versionToken: safeInteger(row.version_token, "当前发布包状态无效"),
      }),
    ]),
  );
}

async function readFiles(client: PoolClient, submissionIds: readonly string[]): Promise<FileRow[]> {
  const result = await client.query<FileRow>(
    `SELECT submission_id,normalized_path,media_type,size_bytes::text,content_digest,blob_ref
       FROM skill_publication_files WHERE submission_id=ANY($1::text[])
      ORDER BY submission_id,normalized_path COLLATE "C"`,
    [submissionIds],
  );
  return result.rows;
}

async function submissionIdExists(client: PoolClient, submissionId: string): Promise<boolean> {
  const result = await client.query<{ readonly present: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM skill_publication_submissions WHERE submission_id=$1) AS present",
    [submissionId],
  );
  return result.rows[0]?.present === true;
}

async function publicationVersionExists(
  client: PoolClient,
  canonicalKey: string,
  version: string,
): Promise<boolean> {
  const result = await client.query<{ readonly present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM skill_publication_submissions
        WHERE canonical_key=$1 AND skill_version=$2
       UNION ALL
       SELECT 1 FROM skills skill JOIN skill_versions version ON version.skill_id=skill.id
        WHERE skill.canonical_key=$1 AND version.version=$2
     ) AS present`,
    [canonicalKey, version],
  );
  return result.rows[0]?.present === true;
}

async function insertSubmission(
  client: PoolClient,
  command: ReturnType<typeof snapshotCreateInput>,
  stored: StoredSkillPublicationPackage,
): Promise<void> {
  const metadata = command.package.metadata;
  await client.query(
    `INSERT INTO skill_publication_submissions(
       submission_id,canonical_key,display_name,publisher,skill_version,description,compatibility,
       source_url,source_revision,license_spdx,status,security_status,package_digest,
       entrypoint_digest,package_blob_ref,file_count,total_bytes,version_token,created_by,
       created_at,updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft','restricted',$11,$12,$13,$14,$15,0,$16,
       clock_timestamp(),clock_timestamp()
     )`,
    [
      command.submissionId,
      metadata.canonicalKey,
      metadata.displayName,
      metadata.publisher,
      metadata.version,
      metadata.description,
      metadata.compatibility,
      metadata.sourceUrl,
      metadata.sourceRevision,
      metadata.licenseSpdx,
      command.package.packageDigest,
      command.package.entrypointDigest,
      stored.packageBlobRef,
      command.package.files.length,
      command.package.totalBytes,
      command.actorUserId,
    ],
  );
}

async function insertPublicationFiles(
  client: PoolClient,
  submissionId: string,
  files: readonly StoredSkillPublicationFile[],
): Promise<void> {
  for (const file of files) {
    await client.query(
      `INSERT INTO skill_publication_files(
         submission_id,normalized_path,media_type,size_bytes,content_digest,blob_ref
       ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [submissionId, file.path, file.mediaType, file.sizeBytes, file.contentDigest, file.blobRef],
    );
  }
}

async function recordCommand(
  client: PoolClient,
  input: {
    readonly actorUserId: string;
    readonly key: string;
    readonly operation: PublicationOperation;
    readonly requestDigest: string;
    readonly submissionId: string;
    readonly versionToken: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO skill_publication_commands(
       actor_user_id,idempotency_key,operation,request_digest,submission_id,result_version_token,
       created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())`,
    [
      input.actorUserId,
      input.key,
      input.operation,
      input.requestDigest,
      input.submissionId,
      input.versionToken,
    ],
  );
}

async function recordAudit(
  client: PoolClient,
  input: {
    readonly submissionId: string;
    readonly actorUserId: string;
    readonly namespace: string;
    readonly skillVersion: string;
    readonly key: string;
    readonly operation: PublicationOperation;
    readonly beforeStatus?: SkillPublicationStatus;
    readonly afterStatus: SkillPublicationStatus;
    readonly reason?: string;
    readonly versionToken: number;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO skill_publication_audits(
       event_id,submission_id,actor_user_id,operation,before_status,after_status,reason,
       version_token,namespace,skill_version,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp())`,
    [
      `${input.operation}:${input.actorUserId}:${input.key}`,
      input.submissionId,
      input.actorUserId,
      input.operation,
      input.beforeStatus ?? null,
      input.afterStatus,
      input.reason ?? null,
      input.versionToken,
      input.namespace,
      input.skillVersion,
    ],
  );
}

async function recordNamespaceAudit(
  client: PoolClient,
  namespace: string,
  actorUserId: string,
  subjectUserId: string | null,
  operation: "create" | "grant" | "revoke",
): Promise<void> {
  await client.query(
    `INSERT INTO skill_namespace_audits(event_id,namespace,actor_user_id,subject_user_id,operation)
     VALUES($1,$2,$3,$4,$5)`,
    [`${operation}:${randomUUID()}`, namespace, actorUserId, subjectUserId, operation],
  );
}

function namespaceFromCanonicalKey(canonicalKey: string): string {
  const separator = canonicalKey.indexOf(".");
  return separator < 1 ? "" : canonicalKey.slice(0, separator);
}

function auditNamespaceFromCanonicalKey(canonicalKey: string): string {
  return namespaceFromCanonicalKey(canonicalKey) || "legacy";
}

async function publishCatalog(
  client: PoolClient,
  submission: SubmissionSnapshot,
  recommended: boolean,
): Promise<string | undefined> {
  await client.query("SET CONSTRAINTS ALL DEFERRED");
  const skillResult = await client.query<{
    readonly id: string;
    readonly publisher: string;
    readonly status: "active" | "revoked";
  }>("SELECT id,publisher,status FROM skills WHERE canonical_key=$1 FOR UPDATE", [
    submission.row.canonical_key,
  ]);
  let skillId: string;
  const existing = skillResult.rows[0];
  if (existing === undefined) {
    // 首次目录可见性必须同时建立推荐版本，避免 active skill 指向空版本。
    if (!recommended) return undefined;
    skillId = catalogSkillId(submission.row.canonical_key);
    await client.query(
      `INSERT INTO skills(
         id,canonical_key,publisher,display_name,recommended_version,status,created_at,updated_at
       ) VALUES ($1,$2,$3,$4,$5,'active',clock_timestamp(),clock_timestamp())`,
      [
        skillId,
        submission.row.canonical_key,
        submission.row.publisher,
        submission.row.display_name,
        submission.row.skill_version,
      ],
    );
  } else {
    if (
      existing.publisher !== submission.row.publisher ||
      (existing.status === "revoked" && !recommended)
    ) {
      return undefined;
    }
    skillId = existing.id;
  }
  const versionExists = await client.query<{ readonly present: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM skill_versions WHERE skill_id=$1 AND version=$2
     ) AS present`,
    [skillId, submission.row.skill_version],
  );
  if (versionExists.rows[0]?.present === true) return undefined;
  await client.query(
    `INSERT INTO skill_versions(
       skill_id,version,description,compatibility,package_digest,entrypoint_path,
       entrypoint_digest,package_blob_ref,security_status,status,created_at
     ) VALUES ($1,$2,$3,$4,$5,'SKILL.md',$6,$7,'restricted','available',clock_timestamp())`,
    [
      skillId,
      submission.row.skill_version,
      submission.row.description,
      submission.row.compatibility,
      submission.row.package_digest,
      submission.row.entrypoint_digest,
      submission.row.package_blob_ref,
    ],
  );
  for (const file of submission.files) {
    await client.query(
      `INSERT INTO skill_version_files(
         skill_id,skill_version,normalized_path,media_type,size_bytes,content_digest,blob_ref
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        skillId,
        submission.row.skill_version,
        file.normalized_path,
        file.media_type,
        safeInteger(file.size_bytes, "Skill 发布文件大小无效"),
        file.content_digest,
        file.blob_ref,
      ],
    );
  }
  if (recommended) {
    await client.query(
      `UPDATE skills
          SET display_name=$2,recommended_version=$3,status='active',updated_at=clock_timestamp()
        WHERE id=$1`,
      [skillId, submission.row.display_name, submission.row.skill_version],
    );
  }
  return skillId;
}

async function revokeCatalog(client: PoolClient, submission: SubmissionSnapshot): Promise<boolean> {
  const skillId = submission.row.published_skill_id;
  if (skillId === null) return false;
  const version = await client.query(
    `UPDATE skill_versions SET status='revoked'
      WHERE skill_id=$1 AND version=$2 AND status='available'`,
    [skillId, submission.row.skill_version],
  );
  if (version.rowCount !== 1) return false;
  await client.query(
    `UPDATE skills
        SET status=CASE WHEN recommended_version=$2 THEN 'revoked' ELSE status END,
            updated_at=clock_timestamp()
      WHERE id=$1`,
    [skillId, submission.row.skill_version],
  );
  return true;
}

function catalogSkillId(canonicalKey: string): string {
  return `skill_${createHash("sha256").update(canonicalKey).digest("hex").slice(0, 32)}`;
}

function mapSubmission(
  snapshot: SubmissionSnapshot,
  entrypointMarkdown: string,
): SkillPublicationSubmission {
  const row = snapshot.row;
  const files: readonly SkillPublicationFileDescriptor[] = Object.freeze(
    snapshot.files.map((file) =>
      Object.freeze({
        path: file.normalized_path,
        mediaType: file.media_type,
        sizeBytes: safeInteger(file.size_bytes, "Skill 发布文件大小无效"),
        contentDigest: file.content_digest,
      }),
    ),
  );
  return Object.freeze({
    submissionId: row.submission_id,
    canonicalKey: row.canonical_key,
    displayName: row.display_name,
    publisher: row.publisher,
    version: row.skill_version,
    description: row.description,
    compatibility: row.compatibility,
    sourceUrl: row.source_url,
    sourceRevision: row.source_revision,
    licenseSpdx: row.license_spdx,
    status: row.status,
    securityStatus: "restricted",
    packageDigest: row.package_digest,
    entrypointDigest: row.entrypoint_digest,
    entrypointMarkdown,
    fileCount: row.file_count,
    totalBytes: safeInteger(row.total_bytes, "Skill 发布总大小无效"),
    versionToken: safeInteger(row.version_token, "Skill 发布版本令牌无效"),
    ...(snapshot.currentPublished === undefined
      ? {}
      : { currentPublished: snapshot.currentPublished }),
    createdBy: userId(row.created_by),
    ...(row.reviewed_by === null ? {} : { reviewedBy: userId(row.reviewed_by) }),
    ...(row.rejection_reason === null ? {} : { rejectionReason: row.rejection_reason }),
    files,
    createdAt: databaseTimestamp(row.created_at),
    updatedAt: databaseTimestamp(row.updated_at),
  });
}

function assertStoredPackage(
  packageInput: ValidatedSkillPublicationPackage,
  stored: StoredSkillPublicationPackage,
): void {
  if (stored.files.length !== packageInput.files.length || stored.packageBlobRef.length > 512) {
    throw new TypeError("Skill 发布对象清单与规范包不一致");
  }
  for (let index = 0; index < packageInput.files.length; index += 1) {
    const expected = packageInput.files[index];
    const actual = stored.files[index];
    if (
      expected === undefined ||
      actual === undefined ||
      actual.path !== expected.path ||
      actual.mediaType !== expected.mediaType ||
      actual.sizeBytes !== expected.sizeBytes ||
      actual.contentDigest !== expected.contentDigest ||
      actual.blobRef.length > 512
    ) {
      throw new TypeError("Skill 发布对象清单与规范包不一致");
    }
  }
}

function snapshotActor(value: UserId | string): string {
  if (!identifierPattern.test(value)) throw new TypeError("Skill 发布用户身份无效");
  return value;
}

function snapshotListInput(input: Parameters<SkillPublicationPort["list"]>[0]) {
  const actorUserId = snapshotActor(input.actorUserId);
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.afterSubmissionId !== undefined && !identifierPattern.test(input.afterSubmissionId)) ||
    (input.latestOnly !== undefined && typeof input.latestOnly !== "boolean")
  ) {
    throw new TypeError("Skill 发布列表参数无效");
  }
  return Object.freeze({
    actorUserId,
    limit: input.limit,
    latestOnly: input.latestOnly ?? false,
    ...(input.afterSubmissionId === undefined
      ? {}
      : { afterSubmissionId: input.afterSubmissionId }),
  });
}

function snapshotGetInput(input: Parameters<SkillPublicationPort["get"]>[0]) {
  const actorUserId = snapshotActor(input.actorUserId);
  if (!identifierPattern.test(input.submissionId)) throw new TypeError("Skill 发布申请 ID 无效");
  return Object.freeze({ actorUserId, submissionId: input.submissionId });
}

function snapshotCreateInput(input: Parameters<SkillPublicationPort["create"]>[0]) {
  const actorUserId = snapshotActor(input.actorUserId);
  assertCommandIdentity(input.submissionId, input.idempotencyKey, input.requestDigest);
  const metadata = Object.freeze({ ...input.package.metadata });
  const files = Object.freeze(
    input.package.files.map((file) =>
      Object.freeze({
        path: file.path,
        mediaType: file.mediaType,
        sizeBytes: file.sizeBytes,
        contentDigest: file.contentDigest,
        body: file.body.slice(),
      }),
    ),
  );
  const packageInput: ValidatedSkillPublicationPackage = Object.freeze({
    metadata,
    files,
    packageManifest: input.package.packageManifest.slice(),
    packageDigest: input.package.packageDigest,
    entrypointDigest: input.package.entrypointDigest,
    entrypointMarkdown: input.package.entrypointMarkdown,
    totalBytes: input.package.totalBytes,
  });
  return Object.freeze({
    actorUserId,
    submissionId: input.submissionId,
    package: packageInput,
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
  });
}

function snapshotTransitionInput(
  input: Parameters<SkillPublicationPort["submit"]>[0],
): TransitionCommand {
  const actorUserId = snapshotActor(input.actorUserId);
  assertCommandIdentity(input.submissionId, input.idempotencyKey, input.requestDigest);
  if (!Number.isSafeInteger(input.expectedVersionToken) || input.expectedVersionToken < 0) {
    throw new TypeError("Skill 发布版本令牌无效");
  }
  return Object.freeze({
    actorUserId,
    submissionId: input.submissionId,
    expectedVersionToken: input.expectedVersionToken,
    idempotencyKey: input.idempotencyKey,
    requestDigest: input.requestDigest,
  });
}

function snapshotReviewInput(input: Parameters<SkillPublicationPort["review"]>[0]) {
  const base = snapshotTransitionInput(input);
  if (
    (input.decision !== "approve" && input.decision !== "reject") ||
    (input.decision === "approve" && input.reason !== undefined) ||
    (input.decision === "reject" && !validReason(input.reason))
  ) {
    throw new TypeError("Skill 发布审核命令无效");
  }
  return Object.freeze({
    ...base,
    decision: input.decision,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

function snapshotPublishInput(input: Parameters<SkillPublicationPort["publish"]>[0]) {
  if (typeof input.recommended !== "boolean") throw new TypeError("Skill 发布推荐标记无效");
  return Object.freeze({ ...snapshotTransitionInput(input), recommended: input.recommended });
}

function snapshotRevokeInput(input: Parameters<SkillPublicationPort["revoke"]>[0]) {
  if (input.reason !== undefined && !validReason(input.reason)) {
    throw new TypeError("Skill 发布下架原因无效");
  }
  return Object.freeze({
    ...snapshotTransitionInput(input),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

function assertCommandIdentity(submissionId: string, key: string, digest: string): void {
  if (
    !identifierPattern.test(submissionId) ||
    !idempotencyKeyPattern.test(key) ||
    !digestPattern.test(digest)
  ) {
    throw new TypeError("Skill 发布命令身份无效");
  }
}

function validReason(value: string | undefined): value is string {
  return (
    value !== undefined &&
    value.length >= 1 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= 2_000 &&
    !Array.from(value).some((character) => {
      const point = character.codePointAt(0);
      return point !== undefined && (point <= 31 || point === 127);
    })
  );
}

function safeInteger(value: string | number, message: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new TypeError(message);
  return parsed;
}

function databaseTimestamp(value: Date | string): ReturnType<typeof isoTimestamp> {
  return isoTimestamp(value instanceof Date ? value.toISOString() : new Date(value).toISOString());
}

function mapPublicationError(error: unknown, operation: string): PersistenceError {
  // COMMIT 可能已成功时只返回可重试的不可用；调用方必须以原幂等键重放，不能猜测失败。
  if (error instanceof TransactionCommitUnknownError) {
    return new PersistenceError("UNAVAILABLE", `${operation}结果未知，请使用相同幂等键重试`);
  }
  return mapPersistenceError(error, operation);
}
