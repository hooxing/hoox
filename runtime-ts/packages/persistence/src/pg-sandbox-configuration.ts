import { randomUUID } from "node:crypto";
import {
  AdminControlServiceError,
  type ManagedSandboxProviderKey,
  normalizeSandboxProviderProfile,
  normalizeSandboxRoutingConfiguration,
  type ResolvedSandboxProfile,
  type SandboxControlConfiguration,
  type SandboxProviderProfile,
  type SandboxProviderProfileRevision,
  type SandboxRoutingConfiguration,
  type SaveSandboxProviderProfile,
  selectSandboxRoutingTarget,
} from "@hoox/admin-control";
import type { Pool, PoolClient } from "pg";
import type {
  EncryptedModelProviderCredential,
  ModelProviderCredentialCipher,
} from "./model-provider-credential.js";
import { withTenantTransaction, withTransaction } from "./postgres.js";

interface ProfileRow {
  provider_key: ManagedSandboxProviderKey;
  revision: string;
  configuration: SandboxProviderProfile;
  credential: EncryptedModelProviderCredential | null;
  created_at: Date;
  healthy?: boolean | null;
}

export async function readSessionSandboxPolicy(
  client: PoolClient,
  tenantId: string,
  sessionId: string,
) {
  const result = await client.query<{ configuration: SandboxProviderProfile }>(
    `SELECT profile.configuration FROM thread_sandbox_sessions session
    JOIN sandbox_configuration_bindings binding ON binding.tenant_id=session.tenant_id AND binding.registry_id=session.registry_id
    JOIN sandbox_provider_profiles profile ON profile.provider_key=binding.provider_key AND profile.revision=binding.profile_revision
    WHERE session.tenant_id=$1 AND session.session_id=$2`,
    [tenantId, sessionId],
  );
  const configuration = result.rows[0]?.configuration;
  return configuration === undefined
    ? undefined
    : normalizeSandboxProviderProfile(configuration).policy;
}

function publicProfile(row: ProfileRow): SandboxProviderProfileRevision {
  return {
    revision: Number(row.revision),
    configuration: normalizeSandboxProviderProfile({
      ...row.configuration,
      credentialConfigured: row.credential !== null,
    }),
    createdAt: row.created_at.toISOString(),
    probeStatus: row.healthy == null ? "untested" : row.healthy ? "healthy" : "failed",
  };
}

async function readRouting(
  client: PoolClient,
  revision: number,
): Promise<SandboxRoutingConfiguration> {
  const result = await client.query<{
    mode: "single" | "weighted";
    provider_key: ManagedSandboxProviderKey;
    profile_revision: string;
    weight: number;
  }>(
    `SELECT routing.mode,target.provider_key,target.profile_revision::text,target.weight
       FROM sandbox_routing_revisions routing JOIN sandbox_routing_targets target ON target.routing_revision=routing.revision
      WHERE routing.revision=$1 ORDER BY target.provider_key`,
    [revision],
  );
  const mode = result.rows[0]?.mode;
  if (!mode) throw new Error("沙箱路由版本缺失");
  return normalizeSandboxRoutingConfiguration({
    mode,
    targets: result.rows.map((row) => ({
      providerKey: row.provider_key,
      profileRevision: Number(row.profile_revision),
      weight: row.weight,
    })),
  });
}

/** 控制面只写不可变版本；凭据投影与密文始终分离。 */
export class PgSandboxControlRepository {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: ModelProviderCredentialCipher,
  ) {}

  private async asActor<T>(
    userId: string,
    write: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return withTransaction(this.pool, async (client) => {
      await client.query("SELECT set_config('app.user_id',$1,true)", [userId]);
      const role = await client.query<{ role: string }>(
        "SELECT role FROM platform_control_operators WHERE user_id=$1 AND status='active'",
        [userId],
      );
      if (!role.rows[0] || (write && role.rows[0].role !== "admin"))
        throw new AdminControlServiceError("NOT_AUTHORIZED");
      return operation(client);
    });
  }

  async overview(userId: string): Promise<SandboxControlConfiguration> {
    return this.asActor(userId, false, async (client) => {
      const head = await client.query<{ generation: string; routing_revision: string | null }>(
        "SELECT generation::text,routing_revision::text FROM sandbox_control_head WHERE singleton=true",
      );
      const row = head.rows[0];
      if (!row) throw new Error("沙箱配置游标缺失");
      const profiles =
        await client.query<ProfileRow>(`SELECT profile.*,probe.healthy FROM sandbox_provider_profiles profile
        LEFT JOIN LATERAL(SELECT healthy FROM sandbox_profile_probes WHERE provider_key=profile.provider_key AND profile_revision=profile.revision ORDER BY created_at DESC,probe_id DESC LIMIT 1) probe ON true
        ORDER BY profile.provider_key,profile.revision DESC`);
      return {
        generation: Number(row.generation),
        routing:
          row.routing_revision === null
            ? undefined
            : await readRouting(client, Number(row.routing_revision)),
        profiles: profiles.rows.map(publicProfile),
      };
    });
  }

  async saveProfile(
    userId: string,
    input: SaveSandboxProviderProfile,
  ): Promise<SandboxProviderProfileRevision> {
    const configuration = normalizeSandboxProviderProfile({
      ...input.configuration,
      credentialConfigured:
        input.apiKey !== undefined || input.reuseCredentialFromRevision !== undefined,
    });
    if (
      input.apiKey !== undefined &&
      (input.apiKey.trim() !== input.apiKey || !input.apiKey || input.apiKey.length > 16384)
    )
      throw new TypeError("沙箱凭据无效");
    if (input.apiKey !== undefined && input.reuseCredentialFromRevision !== undefined)
      throw new TypeError("沙箱凭据写入和复用不能同时指定");
    return this.asActor(userId, true, async (client) => {
      const generation = await this.lockGeneration(client, input.expectedGeneration);
      let credential: EncryptedModelProviderCredential | null = null;
      if (input.apiKey !== undefined)
        credential = this.cipher.encrypt(`sandbox:${configuration.providerKey}`, input.apiKey);
      else if (input.reuseCredentialFromRevision !== undefined) {
        const previous = await client.query<ProfileRow>(
          "SELECT * FROM sandbox_provider_profiles WHERE provider_key=$1 AND revision=$2",
          [configuration.providerKey, input.reuseCredentialFromRevision],
        );
        if (!previous.rows[0]?.credential) throw new AdminControlServiceError("NOT_FOUND");
        credential = previous.rows[0].credential;
      }
      if (configuration.providerKey !== "cube" && !credential)
        throw new TypeError("该供应商需要 API Key");
      const result = await client.query<ProfileRow>(
        `INSERT INTO sandbox_provider_profiles(provider_key,revision,configuration,credential,created_by)
        VALUES($1,(SELECT COALESCE(MAX(revision),0)+1 FROM sandbox_provider_profiles WHERE provider_key=$1),$2,$3,$4) RETURNING *`,
        [configuration.providerKey, configuration, credential, userId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("沙箱配置保存失败");
      await this.audit(
        client,
        userId,
        generation,
        "save_profile",
        Number(row.revision),
        configuration.providerKey,
      );
      return publicProfile(row);
    });
  }

  async publishRouting(
    userId: string,
    input: { expectedGeneration: number; configuration: SandboxRoutingConfiguration },
  ): Promise<void> {
    const configuration = normalizeSandboxRoutingConfiguration(input.configuration);
    return this.asActor(userId, true, async (client) => {
      const generation = await this.lockGeneration(client, input.expectedGeneration);
      for (const target of configuration.targets) {
        const probe = await client.query<{ healthy: boolean }>(
          "SELECT healthy FROM sandbox_profile_probes WHERE provider_key=$1 AND profile_revision=$2 ORDER BY created_at DESC,probe_id DESC LIMIT 1",
          [target.providerKey, target.profileRevision],
        );
        if (probe.rows[0]?.healthy !== true) throw new AdminControlServiceError("PROBE_FAILED");
      }
      await client.query(
        "INSERT INTO sandbox_routing_revisions(revision,mode,created_by) VALUES($1,$2,$3)",
        [generation, configuration.mode, userId],
      );
      for (const target of configuration.targets)
        await client.query(
          "INSERT INTO sandbox_routing_targets(routing_revision,provider_key,profile_revision,weight) VALUES($1,$2,$3,$4)",
          [generation, target.providerKey, target.profileRevision, target.weight],
        );
      await client.query(
        "UPDATE sandbox_control_head SET routing_revision=$1 WHERE singleton=true",
        [generation],
      );
      await this.audit(client, userId, generation, "publish_routing", generation);
    });
  }

  async probeProfile(
    userId: string,
    providerKey: ManagedSandboxProviderKey,
    revision: number,
    probe: (configuration: SandboxProviderProfile, apiKey: string | undefined) => Promise<void>,
  ): Promise<{ healthy: boolean; durationMs: number }> {
    const row = await this.asActor(userId, true, async (client) => {
      const result = await client.query<ProfileRow>(
        "SELECT * FROM sandbox_provider_profiles WHERE provider_key=$1 AND revision=$2",
        [providerKey, revision],
      );
      if (!result.rows[0]) throw new AdminControlServiceError("NOT_FOUND");
      return result.rows[0];
    });
    const started = Date.now();
    let healthy = false;
    try {
      await probe(
        publicProfile(row).configuration,
        row.credential === null
          ? undefined
          : this.cipher.decrypt(`sandbox:${providerKey}`, row.credential),
      );
      healthy = true;
    } catch {
      /* 厂商异常可能包含请求凭据，控制面只保留成功状态与耗时。 */
    }
    const durationMs = Math.min(3600000, Date.now() - started);
    await this.asActor(userId, true, async (client) => {
      const generation = await this.lockGeneration(client);
      await client.query(
        "INSERT INTO sandbox_profile_probes(probe_id,provider_key,profile_revision,healthy,duration_ms,actor_user_id) VALUES($1,$2,$3,$4,$5,$6)",
        [randomUUID(), providerKey, revision, healthy, durationMs, userId],
      );
      await this.audit(client, userId, generation, "probe", revision, providerKey);
    });
    return { healthy, durationMs };
  }

  private async lockGeneration(client: PoolClient, expected?: number): Promise<number> {
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected < 0))
      throw new TypeError("沙箱配置版本无效");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':sandbox-control',0))",
    );
    const result = await client.query<{ generation: string }>(
      "SELECT generation::text FROM sandbox_control_head WHERE singleton=true FOR UPDATE",
    );
    const current = Number(result.rows[0]?.generation);
    if (!Number.isSafeInteger(current)) throw new Error("沙箱配置游标缺失");
    if (expected !== undefined && current !== expected)
      throw new AdminControlServiceError("CONFLICT");
    await client.query(
      "UPDATE sandbox_control_head SET generation=generation+1 WHERE singleton=true",
    );
    return current + 1;
  }

  private async audit(
    client: PoolClient,
    userId: string,
    generation: number,
    action: string,
    revision: number,
    providerKey?: ManagedSandboxProviderKey,
  ) {
    await client.query(
      "INSERT INTO sandbox_control_audits(audit_id,generation,actor_user_id,action,provider_key,revision) VALUES($1,$2,$3,$4,$5,$6)",
      [randomUUID(), generation, userId, action, providerKey ?? null, revision],
    );
  }
}

/** Runtime 在远端调用前提交绑定；重新连接只读绑定，不能用当前路由覆盖旧实例。 */
export class PgSandboxConfigurationResolver {
  constructor(
    private readonly pool: Pool,
    private readonly cipher?: ModelProviderCredentialCipher,
  ) {}

  private decrypt(row: ProfileRow): string {
    if (!this.cipher || !row.credential) throw new Error("托管沙箱凭据解密配置缺失");
    return this.cipher.decrypt(`sandbox:${row.provider_key}`, row.credential);
  }

  async activeProfiles(): Promise<readonly ResolvedSandboxProfile[] | undefined> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || ':sandbox-control',0))",
      );
      const head = await client.query<{ routing_revision: string | null }>(
        "SELECT routing_revision::text FROM sandbox_control_head WHERE singleton=true",
      );
      const revision = head.rows[0]?.routing_revision;
      if (revision === undefined) throw new Error("沙箱配置游标缺失");
      if (revision === null) return undefined;
      const routing = await readRouting(client, Number(revision));
      const profiles: ResolvedSandboxProfile[] = [];
      for (const target of routing.targets) {
        const result = await client.query<ProfileRow>(
          "SELECT * FROM sandbox_provider_profiles WHERE provider_key=$1 AND revision=$2",
          [target.providerKey, target.profileRevision],
        );
        const row = result.rows[0];
        if (!row) throw new Error("活动沙箱配置缺失");
        profiles.push({
          profileRevision: Number(row.revision),
          routingRevision: Number(revision),
          configuration: publicProfile(row).configuration,
          ...(row.credential === null ? {} : { apiKey: this.decrypt(row) }),
        });
      }
      return profiles;
    });
  }

  async bind(input: {
    tenantId: string;
    registryId: string;
  }): Promise<ResolvedSandboxProfile | undefined> {
    return withTenantTransaction(this.pool, input, async (client) => {
      const existing = await this.readBound(client, input);
      if (existing) return existing;
      // 与发布互斥到绑定提交，避免基于已退出活动池的版本新建实例。
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema() || ':sandbox-control',0))",
      );
      const head = await client.query<{ routing_revision: string | null }>(
        "SELECT routing_revision::text FROM sandbox_control_head WHERE singleton=true",
      );
      if (!head.rows[0]) throw new Error("沙箱配置游标缺失");
      if (head.rows[0].routing_revision === null) return undefined;
      const routingRevision = Number(head.rows[0].routing_revision);
      const routing = await readRouting(client, routingRevision);
      const target = selectSandboxRoutingTarget(
        routing,
        JSON.stringify([input.tenantId, input.registryId]),
      );
      await client.query(
        "INSERT INTO sandbox_configuration_bindings(tenant_id,registry_id,routing_revision,provider_key,profile_revision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [
          input.tenantId,
          input.registryId,
          routingRevision,
          target.providerKey,
          target.profileRevision,
        ],
      );
      const bound = await this.readBound(client, input);
      if (!bound) throw new Error("沙箱配置绑定缺失");
      return bound;
    });
  }

  async resolve(input: {
    tenantId: string;
    registryId: string;
  }): Promise<ResolvedSandboxProfile | undefined> {
    return withTenantTransaction(this.pool, input, (client) => this.readBound(client, input));
  }

  async resolveSession(input: {
    tenantId: string;
    sessionId: string;
  }): Promise<ResolvedSandboxProfile | undefined> {
    return withTenantTransaction(this.pool, input, async (client) => {
      const result = await client.query<{ registry_id: string }>(
        "SELECT registry_id FROM thread_sandbox_sessions WHERE tenant_id=$1 AND session_id=$2",
        [input.tenantId, input.sessionId],
      );
      const registryId = result.rows[0]?.registry_id;
      if (!registryId) throw new Error("沙箱会话身份缺失");
      return this.readBound(client, { tenantId: input.tenantId, registryId });
    });
  }

  private async readBound(
    client: PoolClient,
    input: { tenantId: string; registryId: string },
  ): Promise<ResolvedSandboxProfile | undefined> {
    const result = await client.query<ProfileRow & { routing_revision: string }>(
      `SELECT profile.*,binding.routing_revision::text FROM sandbox_configuration_bindings binding
      JOIN sandbox_provider_profiles profile ON profile.provider_key=binding.provider_key AND profile.revision=binding.profile_revision
      WHERE binding.tenant_id=$1 AND binding.registry_id=$2`,
      [input.tenantId, input.registryId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      profileRevision: Number(row.revision),
      routingRevision: Number(row.routing_revision),
      configuration: publicProfile(row).configuration,
      ...(row.credential === null ? {} : { apiKey: this.decrypt(row) }),
    };
  }
}
