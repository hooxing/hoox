import { randomUUID } from "node:crypto";
import { digestCanonical } from "@hoox/run-contracts/mutation-protocol";
import {
  createPlaygroundConfigurationSnapshots,
  RunAgentUnavailableError,
} from "./pg-run-agent-snapshot.js";
import { inputDigest } from "./pg-run-dispatch.js";
import { enqueueThreadFollowUp } from "./pg-thread-run-queue.js";
import { type Pool, withTenantTransaction } from "./postgres.js";

interface PlaygroundRequest {
  readonly scope: { readonly tenantId: string; readonly userId: string };
  readonly definitionId: string;
  readonly revisionId: string;
  readonly message: string;
  readonly mocks: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export class PlaygroundIdempotencyConflictError extends Error {
  readonly code = "PLAYGROUND_IDEMPOTENCY_CONFLICT";
  constructor() {
    super("同一 Playground 幂等键已用于不同请求");
  }
}

export class PgPlaygroundRepository {
  constructor(private readonly pool: Pool) {}

  async accept({
    scope,
    definitionId,
    revisionId,
    message,
    mocks,
    idempotencyKey,
  }: PlaygroundRequest) {
    const { tenantId, userId } = scope;
    const bodyDigest = inputDigest(message);
    const requestDigest = digestCanonical([definitionId, revisionId, message, mocks]);
    return withTenantTransaction(this.pool, scope, async (client) => {
      await client.query("SELECT set_config('app.playground_acceptance','true',true)");
      // 鉴权先于幂等读取，撤销资格后不能用旧键取回 Run。
      const allowed = await client.query("SELECT tenant_id FROM playground_acceptance_scope");
      if (!allowed.rowCount) return undefined;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify(["playground", tenantId, idempotencyKey]),
      ]);
      const prior = await client.query<{
        thread_id: string;
        run_id: string;
        request_digest: string;
      }>(
        `SELECT r.thread_id,m.run_id,m.request_digest FROM run_playground_mocks m
           JOIN runs r ON r.tenant_id=m.tenant_id AND r.id=m.run_id
          WHERE m.tenant_id=$1 AND m.idempotency_key=$2`,
        [tenantId, idempotencyKey],
      );
      const receipt = prior.rows[0];
      if (receipt) {
        if (receipt.request_digest !== requestDigest)
          throw new PlaygroundIdempotencyConflictError();
        return { tenantId, threadId: receipt.thread_id, runId: receipt.run_id };
      }
      const threadId = randomUUID();
      const runId = randomUUID();
      const thread = await client.query(
        `INSERT INTO threads(tenant_id,id,created_by_user_id,title,status,created_at,updated_at,agent_definition_id,is_playground)
        SELECT $1,$2,$3,'Playground','active',now(),now(),d.id,true FROM agent_definitions d WHERE d.id=$4`,
        [tenantId, threadId, userId, definitionId],
      );
      if (!thread.rowCount) throw new RunAgentUnavailableError();
      await client.query(
        `INSERT INTO workspaces(tenant_id,id,thread_id,created_at,updated_at) VALUES($1,$2,$3,now(),now())`,
        [tenantId, randomUUID(), threadId],
      );
      await client.query(
        `INSERT INTO runs(tenant_id,id,thread_id,status,created_at,updated_at,origin) VALUES($1,$2,$3,'queued',now(),now(),'playground')`,
        [tenantId, runId, threadId],
      );
      const snapshot = await createPlaygroundConfigurationSnapshots(client, {
        tenantId,
        userId,
        threadId,
        runId,
        revisionId,
      });
      const allowedMockKeys = new Set(
        snapshot.content.tools.mode === "configured"
          ? [
              ...snapshot.content.tools.externalTools.map((tool) => tool.versionId),
              ...snapshot.content.tools.clientTools.map((tool) => tool.name),
            ]
          : [],
      );
      if (Object.keys(mocks).some((key) => !allowedMockKeys.has(key))) {
        throw new RunAgentUnavailableError();
      }
      await client.query(
        `INSERT INTO run_playground_mocks(tenant_id,run_id,mock_results,idempotency_key,request_digest) VALUES($1,$2,$3::jsonb,$4,$5)`,
        [tenantId, runId, JSON.stringify(mocks), idempotencyKey, requestDigest],
      );
      await enqueueThreadFollowUp(client, {
        tenantId,
        threadId,
        runId,
        clientRequestId: runId,
        requestDigest,
        inputText: message,
        inputDigest: bodyDigest,
      });
      return { tenantId, threadId, runId };
    });
  }
}
