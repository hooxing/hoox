import type { ArtifactExecutionAuthorization } from "@cube-runtime/artifact";
import { resourceVersionId } from "@cube-runtime/domain";
import { type Pool, withTenantTransaction } from "@cube-runtime/persistence";
import type {
  ArtifactPublicationResourcePort,
  ArtifactPublicationSource,
} from "@cube-runtime/tool-router";

/**
 * 已固定 ResourceVersion 的解析仍走 PG 事实源；Workspace 文件则由 intent + 最终
 * RuntimeMutation 闭环，禁止在候选 Revision 提交前从可变 Sandbox 提升。
 */
export class PgArtifactPublicationResourceBridge implements ArtifactPublicationResourcePort {
  constructor(private readonly pool: Pool) {}

  async prepareImmutableVersion(input: {
    readonly authorization: ArtifactExecutionAuthorization;
    readonly source: ArtifactPublicationSource;
  }): ReturnType<ArtifactPublicationResourcePort["prepareImmutableVersion"]> {
    if (input.source.kind === "workspace_file") return { outcome: "unavailable" };
    const source = input.source;
    try {
      const found = await withTenantTransaction(
        this.pool,
        { tenantId: input.authorization.scope.tenantId },
        async (client) => {
          const row = await client.query<{ readonly id: string }>(
            `SELECT version.id
               FROM resource_versions version
               JOIN resources resource
                 ON resource.tenant_id=version.tenant_id AND resource.id=version.resource_id
              WHERE version.tenant_id=$1 AND version.id=$2
                AND resource.visibility='searchable'
              LIMIT 1`,
            [input.authorization.scope.tenantId, source.resourceVersionId],
          );
          return row.rows[0]?.id;
        },
        { readOnly: true },
      );
      return found === undefined
        ? { outcome: "not_found" }
        : { outcome: "ready", resourceVersionId: resourceVersionId(found) };
    } catch {
      return { outcome: "unavailable" };
    }
  }
}
