import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { normalizeExternalToolSchema } from "@hoox/domain";
import { describe, expect, it, vi } from "vitest";
import {
  ExternalToolAdminService,
  type McpProbePort,
} from "../../runtime-ts/packages/admin-control/src/external-tools.js";
import {
  ExternalToolCredentialCipher,
  ExternalToolDraftCredentialCipher,
} from "../../runtime-ts/packages/persistence/src/external-tool-credential.js";
import { PgAgentDefinitionRepository } from "../../runtime-ts/packages/persistence/src/pg-agent-definition.js";
import { PgExternalToolAdminRepository } from "../../runtime-ts/packages/persistence/src/pg-external-tool-admin.js";
import {
  migrateDown,
  type MigrationDownOptions,
} from "../../runtime-ts/packages/persistence/src/migrations.js";
import {
  type Pool,
  withTenantTransaction,
} from "../../runtime-ts/packages/persistence/src/postgres.js";

const settings = {
  displayName: "测试目录",
  serverName: "catalog",
  endpoint: "https://catalog.example.invalid/mcp",
  timeoutMs: 1000,
  maxResponseBytes: 8192,
  sideEffect: "read_only",
  idempotent: true,
} as const;
function tool(remoteToolName: string) {
  const { schema, digest } = normalizeExternalToolSchema({
    type: "object",
    additionalProperties: false,
  });
  return {
    accepted: true as const,
    remoteToolName,
    modelToolName: `mcp__catalog__${remoteToolName}`,
    description: "目录查询",
    inputSchema: schema,
    inputSchemaDigest: digest,
  };
}
const tools = [tool("list"), tool("read")] as const;

async function actor(db: Pool, suffix: string, role: "admin" | "operator") {
  const userId = `user_registry_${suffix}`;
  await withTenantTransaction(db, { userId, tenantId: "tenant_registry" }, async (client) => {
    await client.query("INSERT INTO app_users(id,created_at) VALUES($1,clock_timestamp())", [
      userId,
    ]);
    await client.query(
      "INSERT INTO platform_control_operators(user_id,role,status) VALUES($1,$2,'active')",
      [userId, role],
    );
  });
  return userId;
}

export function externalToolRegistryTests(
  pools: () => { db: Pool; control: Pool },
  migrationSecurity: Pick<
    MigrationDownOptions,
    | "runtimeRole"
    | "migratorRole"
    | "skillPublisherRole"
    | "workerCoordinatorRole"
    | "teamCoordinatorRole"
    | "adminControlRole"
    | "schema"
  >,
) {
  async function fixture(suffix: string, probe: McpProbePort = async () => tools) {
    const { db, control } = pools();
    const actorUserId = await actor(db, suffix, "admin");
    const root = randomBytes(32).toString("hex");
    const repository = new PgExternalToolAdminRepository(
      control,
      new ExternalToolCredentialCipher(root),
      new ExternalToolDraftCredentialCipher(root),
    );
    const service = new ExternalToolAdminService(repository, probe, () => {
      throw new Error("该用例不应调用 HTTP 预览");
    });
    const draft = { actorUserId, draftId: `draft_${suffix}`, expectedGeneration: 0 };
    const create = { ...draft, idempotencyKey: "create-draft", settings };
    const publish = { ...draft, idempotencyKey: "publish-batch" };
    return { db, control, service, draft, create, publish };
  }

  async function publicationState(db: Pool) {
    // 读隔离 Schema 的全表计数，避免通过批次关联查询漏掉半提交的孤立版本、密文或映射。
    return (
      await db.query(`SELECT
      (SELECT count(*) FROM external_tool_publish_batches) AS batches,
      (SELECT count(*) FROM external_tool_versions) AS versions,
      (SELECT count(*) FROM external_tool_credentials) AS credentials,
      (SELECT count(*) FROM external_tool_publish_batch_versions) AS members,
      (SELECT count(*) FROM external_tool_admin_commands) AS commands,
      (SELECT count(*) FROM external_tool_admin_audits WHERE action='published' AND outcome='succeeded') AS successes`)
    ).rows[0];
  }

  describe("外部工具注册管理", () => {
    it("第二个版本写入失败会回滚整个批次，同一命令可成功重试", async () => {
      const { db, service, create, publish } = await fixture("atomic", async () => [
        tool("first"),
        tool("fail_write"),
      ]);
      await service.createMcpDraft({ ...create, credential: "test-placeholder" });
      const before = await publicationState(db);
      // 只让第二个已通过领域校验的版本在 INSERT 时失败，区别于探测拒绝或提前校验。
      await db.query(
        "ALTER TABLE external_tool_versions ADD CONSTRAINT registry_test_fault CHECK (model_tool_name <> 'mcp__catalog__fail_write')",
      );
      try {
        await expect(service.publish(publish)).rejects.toMatchObject({ cause: { code: "23514" } });
        expect(await publicationState(db)).toEqual(before);
      } finally {
        await db.query("ALTER TABLE external_tool_versions DROP CONSTRAINT registry_test_fault");
      }
      const batch = await service.publish(publish);
      expect(batch.sequence).toBe(1);
      expect(batch.tools.map((t) => t.remoteToolName).sort()).toEqual(["fail_write", "first"]);
    });

    it.each([
      ["混合清单", "mixed"],
      ["空清单", "empty"],
      ["连接失败", "failed"],
    ] as const)("成功预览后发布必须重新探测：%s 不产生任何版本", async (scenario, suffix) => {
      let probeCount = 0;
      const { db, service, draft, create, publish } = await fixture(`probe_${suffix}`, async () => {
        if (++probeCount === 1) return tools;
        if (scenario === "连接失败") throw new Error("测试远端原文");
        if (scenario === "空清单") return [];
        return [
          tools[0],
          {
            accepted: false,
            remoteToolName: "unsupported",
            reason: "MCP_SCHEMA_REJECTED",
            reasonMessage: "Schema 不受支持",
          },
        ];
      });
      await service.createMcpDraft(create);
      expect((await service.probe(draft)).publishable).toBe(true);
      const before = await publicationState(db);
      const report = await service.probe(draft);
      expect(report.publishable).toBe(false);
      if (scenario === "混合清单")
        expect(report.tools.map((t) => t.accepted)).toEqual([true, false]);
      if (scenario === "连接失败")
        expect(JSON.stringify(report).includes("测试远端原文")).toBe(false);
      await expect(service.publish(publish)).rejects.toMatchObject({
        code: scenario === "连接失败" ? "PROBE_UNAVAILABLE" : "PUBLISH_REJECTED",
      });
      expect(probeCount).toBe(3);
      expect(await publicationState(db)).toEqual(before);
      const outcome = scenario === "连接失败" ? "failed" : "rejected";
      expect(
        (
          await db.query(
            "SELECT action,outcome FROM external_tool_admin_audits WHERE object_id=$1 AND action IN ('probed','published') ORDER BY audit_id",
            [draft.draftId],
          )
        ).rows,
      ).toEqual([
        { action: "probed", outcome: "succeeded" },
        { action: "probed", outcome },
        { action: "published", outcome },
      ]);
    });

    it("探测端口误报合规时，发布仍拒绝包含不受支持 Schema 的整批工具", async () => {
      const invalid = {
        ...tool("legacy"),
        inputSchema: { type: "object", additionalProperties: true },
      };
      const { db, service, create, publish } = await fixture("schema", async () => [
        tools[0],
        invalid,
      ]);
      await service.createMcpDraft(create);
      const before = await publicationState(db);
      await expect(service.publish(publish)).rejects.toMatchObject({ code: "PUBLISH_REJECTED" });
      expect(await publicationState(db)).toEqual(before);
    });

    it("凭据必须先清除才可更改 endpoint，下一次探测不向新地址传送旧凭据", async () => {
      const credential = randomBytes(32).toString("hex");
      const observed: { endpoint: string; oldCredential: boolean; noCredential: boolean }[] = [];
      const { service, draft, create } = await fixture("endpoint", async (input) => {
        observed.push({
          endpoint: input.endpoint,
          oldCredential: input.credential === credential,
          noCredential: input.credential === undefined,
        });
        return tools;
      });
      const saved = await service.createMcpDraft({ ...create, credential });
      const nextEndpoint = "https://other.example.invalid/mcp";
      const edit = {
        ...draft,
        expectedGeneration: saved.generation,
        idempotencyKey: "change-endpoint",
        settings: { ...settings, endpoint: nextEndpoint },
      };
      await expect(service.updateMcpDraft(edit)).rejects.toMatchObject({ code: "CONFLICT" });
      expect(
        (await service.probe({ ...draft, expectedGeneration: saved.generation })).publishable,
      ).toBe(true);
      const cleared = await service.setDraftCredential({
        ...draft,
        expectedGeneration: saved.generation,
        credential: null,
        idempotencyKey: "clear-credential",
      });
      const changed = await service.updateMcpDraft({
        ...edit,
        idempotencyKey: "change-cleared-endpoint",
        expectedGeneration: cleared.generation,
      });
      expect(changed.credentialConfigured).toBe(false);
      expect(
        (await service.probe({ ...draft, expectedGeneration: changed.generation })).publishable,
      ).toBe(true);
      expect(observed).toEqual([
        { endpoint: settings.endpoint, oldCredential: true, noCredential: false },
        { endpoint: nextEndpoint, oldCredential: false, noCredential: true },
      ]);
    });

    it("凭据只写；重放不重复发布、撤销或审计，同键更换凭据拒绝", async () => {
      const credential = randomBytes(32).toString("hex");
      const probeCredentials: boolean[] = [];
      const { db, service, draft, create, publish } = await fixture("replay", async (input) => {
        probeCredentials.push(input.credential === credential);
        return tools;
      });
      await service.createMcpDraft(create);
      const set = { ...draft, idempotencyKey: "set-credential", credential };
      const saved = await service.setDraftCredential(set);
      const savedAgain = await service.setDraftCredential(set);
      expect(saved.credentialConfigured).toBe(true);
      expect(isDeepStrictEqual(savedAgain, saved)).toBe(true);
      await expect(
        service.setDraftCredential({ ...set, credential: "another-test-placeholder" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const command = { ...publish, expectedGeneration: saved.generation };
      const batch = await service.publish(command);
      const again = await service.publish(command);
      expect(isDeepStrictEqual(again, batch)).toBe(true);
      expect(probeCredentials).toEqual([true]);
      expect(batch.tools.map((t) => t.credentialConfigured)).toEqual([true, true]);
      const revoke = {
        actorUserId: draft.actorUserId,
        batchId: batch.batchId,
        idempotencyKey: "revoke-batch",
        reason: "测试撤销",
      };
      const revoked = await service.revokeBatch(revoke);
      const revokedAgain = await service.revokeBatch(revoke);
      expect(isDeepStrictEqual(revokedAgain, revoked)).toBe(true);
      expect(revokedAgain.tools.map((t) => t.revoked)).toEqual([true, true]);
      const overview = await service.overview(draft.actorUserId);
      const commands = (
        await db.query("SELECT * FROM external_tool_admin_commands WHERE actor_user_id=$1", [
          draft.actorUserId,
        ])
      ).rows;
      const audits = (
        await db.query(
          "SELECT * FROM external_tool_admin_audits WHERE actor_user_id=$1 ORDER BY audit_id",
          [draft.actorUserId],
        )
      ).rows;
      const envelopes = (
        await db.query(
          `SELECT nonce,ciphertext,auth_tag FROM external_tool_draft_credentials WHERE draft_id=$1
        UNION ALL SELECT c.nonce,c.ciphertext,c.auth_tag FROM external_tool_credentials c JOIN external_tool_publish_batch_versions bv USING(tool_version_id) WHERE bv.batch_id=$2`,
          [draft.draftId, batch.batchId],
        )
      ).rows;
      expect(envelopes.length).toBe(3);
      expect(new Set(envelopes.map((e) => e.ciphertext)).size).toBe(3);
      // 断言只输出布尔值；若发生回显，失败报告也不得带出明文或密文。
      const exposed = JSON.stringify([
        saved,
        savedAgain,
        batch,
        again,
        revoked,
        revokedAgain,
        overview,
        audits,
        commands,
      ]);
      expect(
        [credential, ...envelopes.flatMap((e) => [e.ciphertext, e.nonce, e.auth_tag])].some(
          (value) => exposed.includes(value),
        ),
      ).toBe(false);
      expect(JSON.stringify(envelopes).includes(credential)).toBe(false);
      expect(commands.map((c) => c.idempotency_key).sort()).toEqual([
        "create-draft",
        "publish-batch",
        "revoke-batch",
        "set-credential",
      ]);
      expect(audits.map((a) => [a.action, a.outcome, a.object_id])).toEqual([
        ["draft_saved", "succeeded", draft.draftId],
        ["credential_changed", "succeeded", draft.draftId],
        ["published", "succeeded", batch.batchId],
        ["revoked", "succeeded", batch.batchId],
      ]);
    });

    it("operator 只能读取 Agent 选择投影，不能注册、探测、接触凭据、发布或撤销", async () => {
      let probes = 0;
      const { db, control, service, create, publish } = await fixture("acl_admin", async () => {
        probes++;
        return tools;
      });
      const operator = await actor(db, "acl_operator", "operator");
      await service.createMcpDraft({ ...create, credential: "test-placeholder" });
      const batch = await service.publish(publish);
      const command = { ...publish, actorUserId: operator };
      const denied = { code: "NOT_AUTHORIZED" };
      await expect(service.overview(operator)).rejects.toMatchObject(denied);
      await expect(
        service.createMcpDraft({ ...create, draftId: "operator_draft", actorUserId: operator }),
      ).rejects.toMatchObject(denied);
      await expect(service.updateMcpDraft({ ...command, settings })).rejects.toMatchObject(denied);
      await expect(
        service.setDraftCredential({ ...command, credential: null }),
      ).rejects.toMatchObject(denied);
      await expect(service.probe(command)).rejects.toMatchObject(denied);
      await expect(service.publish(command)).rejects.toMatchObject(denied);
      await expect(
        service.revokeBatch({ ...command, batchId: batch.batchId, reason: "越权撤销" }),
      ).rejects.toMatchObject(denied);
      expect(probes).toBe(1);
      const agents = new PgAgentDefinitionRepository(control);
      const versions = batch.tools.map((t) => t.toolVersionId);
      const options = (await agents.listDefinitions(operator)).externalToolOptions.filter((t) =>
        versions.includes(t.toolVersionId),
      );
      expect(options).toEqual(
        batch.tools.map((t) => ({
          toolVersionId: t.toolVersionId,
          source: "mcp",
          modelToolName: t.modelToolName,
          description: t.description,
          batchName: batch.displayName,
        })),
      );
      // 服务鉴权之外再用实际控制角色查底表，证明即使绕开服务方法也拿不到注册和密文行。
      await withTenantTransaction(
        control,
        { tenantId: "tenant_registry", userId: operator },
        async (client) => {
          for (const table of [
            "external_tool_versions",
            "external_tool_registration_drafts",
            "external_tool_draft_credentials",
            "external_tool_publish_batches",
            "external_tool_publish_batch_versions",
            "external_tool_admin_publish_claims",
            "external_tool_admin_commands",
            "external_tool_admin_audits",
          ]) {
            expect(
              (await client.query(`SELECT EXISTS(SELECT 1 FROM ${table}) AS visible`)).rows[0]
                ?.visible,
              table,
            ).toBe(false);
          }
        },
      );
      await expect(
        withTenantTransaction(
          control,
          { tenantId: "tenant_registry", userId: operator },
          (client) => client.query("SELECT ciphertext FROM external_tool_credentials"),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it.each(["无发布记录", "已撤销"] as const)(
      "%s的版本不可被 Agent 保存，已有草稿也不能发布",
      async (state) => {
        const suffix = state === "已撤销" ? "revoked" : "unlisted";
        const { db, control, service, create, publish } = await fixture(`agent_${suffix}`);
        await service.createMcpDraft(create);
        const batch = await service.publish(publish);
        const versionId = batch.tools[0]?.toolVersionId;
        if (!versionId) throw new Error("发布结果缺少工具版本");
        const actorUserId = await actor(db, `agent_editor_${suffix}`, "operator");
        const agents = new PgAgentDefinitionRepository(control);
        const template = await agents.readAdminRevision(
          actorUserId,
          "agent_default",
          "agent_default_revision_1",
        );
        if (!template) throw new Error("缺少默认 Agent Revision 夹具");
        const content = {
          ...template.content,
          tools: {
            mode: "configured" as const,
            builtinTools: [],
            externalTools: [{ kind: "mcp" as const, versionId }],
            clientTools: [],
            toolCallingMode: "native" as const,
          },
        };
        const definitionId = `agent_registry_${suffix}`;
        const revisionId = `${definitionId}_1`;
        const draft = {
          id: definitionId,
          revisionId,
          actorUserId,
          expectedGeneration: 0,
          idempotencyKey: `${definitionId}_save`,
          availability: { mode: "all_tenants" as const },
          content,
        };
        const invalid = {
          code: "CONSTRAINT_VIOLATION",
          message: expect.stringContaining("外部工具"),
        };
        await expect(
          agents.createDraft({
            ...draft,
            content: {
              ...content,
              tools: { ...content.tools, externalTools: [{ kind: "http", versionId }] },
            },
          }),
        ).rejects.toMatchObject(invalid);
        await agents.createDraft(draft);
        if (state === "已撤销") {
          await service.revokeBatch({
            actorUserId: create.actorUserId,
            batchId: batch.batchId,
            reason: "工具退役",
            idempotencyKey: "retire-batch",
          });
        } else {
          // 构造遗留版本：不可变版本仍存在，但没有注册批次背书，不能仅按版本主键判定可选。
          expect(
            (
              await db.query(
                "DELETE FROM external_tool_publish_batch_versions WHERE tool_version_id=$1",
                [versionId],
              )
            ).rowCount,
          ).toBe(1);
        }
        const visible = (await agents.listDefinitions(actorUserId)).externalToolOptions.map(
          (o) => o.toolVersionId,
        );
        expect(visible).not.toContain(versionId);
        await expect(
          agents.createDraftRevision({
            actorUserId,
            definitionId,
            revisionId: `${definitionId}_2`,
            content,
            expectedGeneration: 0,
            idempotencyKey: `${definitionId}_revise`,
          }),
        ).rejects.toMatchObject(invalid);
        await expect(
          agents.publish({
            actorUserId,
            definitionId,
            revisionId,
            expectedGeneration: 0,
            idempotencyKey: `${definitionId}_publish`,
          }),
        ).rejects.toMatchObject(invalid);
        const result = await agents.listRevisions(actorUserId, definitionId);
        expect(result?.definition).toMatchObject({ status: "draft", generation: 0 });
        expect(
          (await agents.readAdminRevision(actorUserId, definitionId, revisionId))?.status,
        ).toBe("draft");
      },
    );

    it("跨连接同键并发发布只探测并提交一次，异摘要冲突", async () => {
      let probeCount = 0;
      let releaseProbe!: () => void;
      const probeGate = new Promise<void>((resolve) => {
        releaseProbe = resolve;
      });
      const probe: McpProbePort = async () => {
        probeCount++;
        if (probeCount === 1) await probeGate;
        return tools;
      };
      const { db, control, service, create, publish } = await fixture("claim_parallel", probe);
      await service.createMcpDraft(create);
      const before = await publicationState(db);
      const root = randomBytes(32).toString("hex");
      const secondService = new ExternalToolAdminService(
        new PgExternalToolAdminRepository(
          control,
          new ExternalToolCredentialCipher(root),
          new ExternalToolDraftCredentialCipher(root),
        ),
        probe,
        () => {
          throw new Error("该用例不应调用 HTTP 预览");
        },
      );
      const first = service.publish(publish);
      await vi.waitFor(() => expect(probeCount).toBe(1));
      const second = secondService.publish(publish);
      try {
        await expect(
          secondService.publish({ ...publish, draftId: "different_draft" }),
        ).rejects.toMatchObject({ code: "CONFLICT" });
        await new Promise((resolve) => setTimeout(resolve, 350));
        expect(probeCount).toBe(1);
      } finally {
        releaseProbe();
      }
      const [firstBatch, replayedBatch] = await Promise.all([first, second]);
      expect(firstBatch.batchId).toBe(replayedBatch.batchId);
      expect(probeCount).toBe(1);
      expect(Number((await publicationState(db)).batches)).toBe(Number(before.batches) + 1);
      await expect(
        secondService.publish({ ...publish, draftId: "different_draft" }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("明确失败释放执行权但保留摘要，同键可恢复且异请求不能复用", async () => {
      const probe = vi.fn<McpProbePort>().mockRejectedValueOnce(new Error("受控失败"));
      const { db, service, create, publish } = await fixture("claim_retry", probe);
      await service.createMcpDraft(create);
      await expect(service.publish(publish)).rejects.toMatchObject({ code: "PROBE_UNAVAILABLE" });
      await expect(service.publish({ ...publish, expectedGeneration: 1 })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(service.updateMcpDraft({ ...publish, settings })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(probe).toHaveBeenCalledTimes(1);
      probe.mockResolvedValue(tools);
      await service.publish(publish);
      expect(probe).toHaveBeenCalledTimes(2);
      expect(
        (
          await db.query(
            "SELECT lease_expires_at <= clock_timestamp() AS settled FROM external_tool_admin_publish_claims WHERE actor_user_id=$1 AND idempotency_key=$2",
            [publish.actorUserId, publish.idempotencyKey],
          )
        ).rows,
      ).toEqual([{ settled: true }]);
    });

    it("超时声明可由另一连接接管，旧执行者不能提交或释放新声明", async () => {
      const releases: (() => void)[] = [];
      const probe: McpProbePort = async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return tools;
      };
      const { db, control, service, create, publish } = await fixture("claim_expired", probe);
      await service.createMcpDraft(create);
      const before = await publicationState(db);
      const first = service.publish(publish);
      const firstResult = expect(first).rejects.toMatchObject({ code: "CONFLICT" });
      await vi.waitFor(() => expect(releases).toHaveLength(1));
      await db.query(
        "UPDATE external_tool_admin_publish_claims SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE actor_user_id=$1 AND idempotency_key=$2",
        [publish.actorUserId, publish.idempotencyKey],
      );
      const root = randomBytes(32).toString("hex");
      const successor = new ExternalToolAdminService(
        new PgExternalToolAdminRepository(
          control,
          new ExternalToolCredentialCipher(root),
          new ExternalToolDraftCredentialCipher(root),
        ),
        probe,
        () => {
          throw new Error("不使用 HTTP 预览");
        },
      );
      const second = successor.publish(publish);
      try {
        await vi.waitFor(() => expect(releases).toHaveLength(2));
        releases[0]?.();
        await firstResult;
        expect(await publicationState(db)).toEqual(before);
        expect(
          (
            await db.query(
              "SELECT lease_expires_at > clock_timestamp() AS active FROM external_tool_admin_publish_claims WHERE actor_user_id=$1 AND idempotency_key=$2",
              [publish.actorUserId, publish.idempotencyKey],
            )
          ).rows,
        ).toEqual([{ active: true }]);
      } finally {
        for (const release of releases) release();
      }
      await second;
      expect(Number((await publicationState(db)).batches)).toBe(Number(before.batches) + 1);
    });

    it.each(["before", "after"] as const)(
      "COMMIT %s 断响应时精确读回，缺少回执则保留租约后恢复",
      async (phase) => {
        const probe = vi.fn<McpProbePort>().mockResolvedValue(tools);
        const { db, control, service, create, publish } = await fixture(
          `commit_unknown_${phase}`,
          probe,
        );
        await service.createMcpDraft(create);
        const before = await publicationState(db);
        let dropped = false;
        // 真实事务只在发布的 COMMIT 边界丢失响应，覆盖驱动异常到结果未知的完整映射。
        const faultyControl = new Proxy(control, {
          get(target, property, receiver) {
            if (property !== "connect") return Reflect.get(target, property, receiver);
            return async () => {
              const client = await target.connect();
              let publishing = false;
              return new Proxy(client, {
                get(connection, key, connectionReceiver) {
                  if (key !== "query") return Reflect.get(connection, key, connectionReceiver);
                  return async (...args: unknown[]) => {
                    if (
                      typeof args[0] === "string" &&
                      args[0].includes("INSERT INTO external_tool_publish_batches")
                    )
                      publishing = true;
                    const drop = args[0] === "COMMIT" && publishing && !dropped;
                    const fail = () => {
                      dropped = true;
                      throw Object.assign(new Error("测试提交响应丢失"), { code: "ECONNRESET" });
                    };
                    if (drop && phase === "before") fail();
                    const result: unknown = await Reflect.apply(connection.query, connection, args);
                    if (drop) fail();
                    return result;
                  };
                },
              });
            };
          },
        });
        const root = randomBytes(32).toString("hex");
        const faultyService = new ExternalToolAdminService(
          new PgExternalToolAdminRepository(
            faultyControl,
            new ExternalToolCredentialCipher(root),
            new ExternalToolDraftCredentialCipher(root),
          ),
          probe,
          () => {
            throw new Error("不使用 HTTP 预览");
          },
        );
        let batch: Awaited<ReturnType<ExternalToolAdminService["publish"]>> | undefined;
        if (phase === "before") {
          await expect(faultyService.publish(publish)).rejects.toMatchObject({
            code: "PUBLISH_RESULT_UNKNOWN",
          });
          expect(await publicationState(db)).toEqual(before);
          expect(
            (
              await db.query(
                "SELECT lease_expires_at > clock_timestamp() AS active FROM external_tool_admin_publish_claims WHERE actor_user_id=$1 AND idempotency_key=$2",
                [publish.actorUserId, publish.idempotencyKey],
              )
            ).rows,
          ).toEqual([{ active: true }]);
          await db.query(
            "UPDATE external_tool_admin_publish_claims SET lease_expires_at=clock_timestamp() WHERE actor_user_id=$1 AND idempotency_key=$2",
            [publish.actorUserId, publish.idempotencyKey],
          );
        } else batch = await faultyService.publish(publish);
        const successor = new ExternalToolAdminService(
          new PgExternalToolAdminRepository(
            control,
            new ExternalToolCredentialCipher(root),
            new ExternalToolDraftCredentialCipher(root),
          ),
          probe,
          () => {
            throw new Error("不使用 HTTP 预览");
          },
        );
        const recovered = await successor.publish(publish);
        if (batch !== undefined) expect(recovered).toEqual(batch);
        expect(dropped).toBe(true);
        expect(probe).toHaveBeenCalledTimes(phase === "before" ? 2 : 1);
        expect(Number((await publicationState(db)).batches)).toBe(Number(before.batches) + 1);
      },
    );

    it("注册与审计数据存在时拒绝回退且数据和迁移记录不变", async () => {
      const { db, service, create, publish } = await fixture("rollback_guard");
      await service.createMcpDraft(create);
      await service.publish(publish);
      const beforeData = await db.query(`SELECT
        (SELECT count(*)::text FROM external_tool_registration_drafts) AS drafts,
        (SELECT count(*)::text FROM external_tool_draft_credentials) AS draft_credentials,
        (SELECT count(*)::text FROM external_tool_publish_batches) AS batches,
        (SELECT count(*)::text FROM external_tool_admin_commands) AS commands,
        (SELECT count(*)::text FROM external_tool_admin_audits) AS audits`);
      const beforeMigrations = await db.query(
        "SELECT version,name,checksum FROM runtime_schema_migrations ORDER BY version",
      );
      const migration = beforeMigrations.rows.find((row) => row.name === "external_tool_admin");
      if (!migration) throw new Error("缺少外部工具注册迁移");
      await expect(
        migrateDown(db, {
          targetVersion: Number(migration.version) - 1,
          allowDestructive: true,
          environment: "test",
          ...migrationSecurity,
        }),
      ).rejects.toMatchObject({ code: "UNEXPECTED", cause: { code: "P0001" } });
      expect(
        (
          await db.query(`SELECT
        (SELECT count(*)::text FROM external_tool_registration_drafts) AS drafts,
        (SELECT count(*)::text FROM external_tool_draft_credentials) AS draft_credentials,
        (SELECT count(*)::text FROM external_tool_publish_batches) AS batches,
        (SELECT count(*)::text FROM external_tool_admin_commands) AS commands,
        (SELECT count(*)::text FROM external_tool_admin_audits) AS audits`)
        ).rows,
      ).toEqual(beforeData.rows);
      expect(
        (
          await db.query(
            "SELECT version,name,checksum FROM runtime_schema_migrations ORDER BY version",
          )
        ).rows,
      ).toEqual(beforeMigrations.rows);
    });
  });
}
