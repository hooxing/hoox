import { type AgentRevisionContent, sha256Digest } from "@hoox/domain";
import { type RunAgentSnapshot, verifyRunAgentContent } from "@hoox/run-contracts";
import type { PoolClient } from "pg";
import { PersistenceError } from "./errors.js";
import { createRunSkillSnapshot } from "./pg-skill-runtime.js";

type AgentScope = { readonly tenantId: string; readonly threadId: string; readonly runId: string };
interface SnapshotRow {
  readonly definition_id: string;
  readonly revision_id: string;
  readonly revision_digest: string;
  readonly content: AgentRevisionContent;
}

export class RunAgentUnavailableError extends PersistenceError {
  constructor() {
    super("AGENT_REVISION_UNAVAILABLE", "Agent 未启用或缺少可用的已发布 Revision");
  }
}

function mapSnapshot(row: SnapshotRow): RunAgentSnapshot {
  return Object.freeze({
    definitionId: row.definition_id,
    revisionId: row.revision_id,
    revisionDigest: sha256Digest(row.revision_digest),
    content: verifyRunAgentContent(row.content, row.revision_digest),
  });
}

/** Run 或候选 Run 的两个快照必须共用输入受理事务。 */
export async function createRunConfigurationSnapshots(
  client: PoolClient,
  input: AgentScope & Parameters<typeof createRunSkillSnapshot>[1],
): Promise<void> {
  const inserted = await client.query<SnapshotRow>(
    `INSERT INTO run_agent_snapshots(tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content)
     SELECT t.tenant_id,$3,t.id,d.id,r.id,r.content_digest,r.content
       FROM threads t
       JOIN agent_definitions d ON d.id=t.agent_definition_id AND d.status='published'
       JOIN agent_revisions r ON r.definition_id=d.id AND r.id=d.current_revision_id AND r.status='published'
      WHERE t.tenant_id=$1 AND t.id=$2 AND (d.availability_mode='all_tenants' OR EXISTS (
        SELECT 1 FROM agent_definition_tenants scope
         WHERE scope.definition_id=d.id AND scope.tenant_id=t.tenant_id AND scope.available
      ))
     RETURNING definition_id,revision_id,revision_digest,content`,
    [input.tenantId, input.threadId, input.runId],
  );
  await finalizeSkillSnapshot(client, input, inserted.rows[0]);
}

export async function createPlaygroundConfigurationSnapshots(
  client: PoolClient,
  input: AgentScope & { readonly userId: string; readonly revisionId: string },
): Promise<RunAgentSnapshot> {
  const inserted = await client.query<SnapshotRow>(
    `INSERT INTO run_agent_snapshots(tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content)
     SELECT t.tenant_id,$3,t.id,t.agent_definition_id,r.id,r.content_digest,r.content
       FROM threads t JOIN agent_revisions r ON r.definition_id=t.agent_definition_id
      WHERE t.tenant_id=$1 AND t.id=$2 AND t.is_playground AND r.id=$4 AND r.status IN ('draft','published')
     RETURNING definition_id,revision_id,revision_digest,content`,
    [input.tenantId, input.threadId, input.runId, input.revisionId],
  );
  return await finalizeSkillSnapshot(client, input, inserted.rows[0]);
}

export async function createEvaluationConfigurationSnapshots(
  client: PoolClient,
  input: AgentScope & { readonly userId: string; readonly revisionId: string },
): Promise<RunAgentSnapshot> {
  const inserted = await client.query<SnapshotRow>(
    `INSERT INTO run_agent_snapshots(tenant_id,run_id,thread_id,definition_id,revision_id,revision_digest,content)
     SELECT t.tenant_id,$3,t.id,t.agent_definition_id,r.id,r.content_digest,r.content
       FROM threads t
       JOIN runs run ON run.tenant_id=t.tenant_id AND run.id=$3 AND run.thread_id=t.id AND run.origin='evaluation'
       JOIN agent_revisions r ON r.definition_id=t.agent_definition_id AND r.id=$4
        AND r.status IN ('draft','published')
      WHERE t.tenant_id=$1 AND t.id=$2
     RETURNING definition_id,revision_id,revision_digest,content`,
    [input.tenantId, input.threadId, input.runId, input.revisionId],
  );
  return await finalizeSkillSnapshot(client, input, inserted.rows[0]);
}

async function finalizeSkillSnapshot(
  client: PoolClient,
  input: Parameters<typeof createRunSkillSnapshot>[1],
  row: SnapshotRow | undefined,
): Promise<RunAgentSnapshot> {
  if (row === undefined) throw new RunAgentUnavailableError();
  let snapshot: RunAgentSnapshot;
  try {
    snapshot = mapSnapshot(row);
  } catch {
    throw new RunAgentUnavailableError();
  }
  await createRunSkillSnapshot(client, {
    ...input,
    agentSkillVersions: snapshot.content.skillVersions,
    includeTenantSkills: snapshot.content.includeTenantSkills,
  });
  return snapshot;
}

export async function readRunAgentSnapshot(
  client: PoolClient,
  scope: AgentScope,
): Promise<RunAgentSnapshot | undefined> {
  const result = await client.query<SnapshotRow>(
    `SELECT s.definition_id,s.revision_id,s.revision_digest,s.content
       FROM run_agent_snapshots s JOIN threads t
         ON t.tenant_id=s.tenant_id AND t.id=s.thread_id AND t.agent_definition_id=s.definition_id
      WHERE s.tenant_id=$1 AND s.thread_id=$2 AND s.run_id=$3`,
    [scope.tenantId, scope.threadId, scope.runId],
  );
  const row = result.rows[0];
  try {
    return row === undefined ? undefined : mapSnapshot(row);
  } catch {
    return undefined;
  }
}

export async function isRunAgentRevoked(client: PoolClient, scope: AgentScope): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM run_agent_snapshots s
       JOIN agent_revision_revocations r ON r.revision_id=s.revision_id
      WHERE s.tenant_id=$1 AND s.thread_id=$2 AND s.run_id=$3`,
    [scope.tenantId, scope.threadId, scope.runId],
  );
  return result.rowCount === 1;
}
