import {
  isoTimestamp,
  normalizeExternalToolSchema,
  runId,
  tenantId,
  threadId,
  workspaceId,
} from "@hoox/domain";
import { type ExecutionFence, ExternalToolSnapshotError } from "@hoox/run-contracts";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PgExternalToolSnapshotReader } from "./pg-external-tool-snapshot-reader.js";

const schema = normalizeExternalToolSchema({
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
});

const fence: ExecutionFence = {
  scope: {
    tenantId: tenantId("tenant-a"),
    threadId: threadId("thread-a"),
    runId: runId("run-a"),
    rootRunId: runId("run-a"),
    workspaceId: workspaceId("workspace-a"),
  },
  runClaim: { token: "claim-a", epoch: 1, expiresAt: isoTimestamp("2099-01-01T00:00:00.000Z") },
  workspaceLease: {
    rootRunId: runId("run-a"),
    epoch: 2,
    expiresAt: isoTimestamp("2099-01-01T00:00:00.000Z"),
  },
};

function poolWithRows(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.startsWith("SELECT tool_version_id")) return { rows };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, query };
}

const row = {
  tool_version_id: "version-a",
  revoked: false,
  source: "http",
  endpoint: "https://tools.example.invalid/lookup",
  model_tool_name: "http__lookup",
  remote_tool_name: null,
  description: "查询记录",
  input_schema: schema.schema,
  input_schema_digest: schema.digest,
  timeout_ms: 1000,
  max_response_bytes: 512,
  side_effect: "read_only",
  idempotent: true,
  credential_ref: null,
  credential_configured: false,
  http_method: "GET",
  cipher_version: null,
  nonce: null,
  ciphertext: null,
  auth_tag: null,
};

describe("PgExternalToolSnapshotReader", () => {
  it("在 Tenant/Run 事务中读取受限视图中的精确版本", async () => {
    const { pool, query } = poolWithRows([row]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() } as never);
    const snapshots = await reader.read({
      fence,
      toolVersionIds: ["version-a"],
    });
    expect(snapshots.map((snapshot) => snapshot.tool.toolVersionId)).toEqual(["version-a"]);
    expect(snapshots[0]?.tool.httpMethod).toBe("GET");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("app.external_claim_token"), [
      "claim-a",
      "1",
      "2",
    ]);
    expect(query.mock.calls.at(-2)?.[1]).toEqual([
      "tenant-a",
      "run-a",
      ["version-a"],
      "thread-a",
      "run-a",
      "workspace-a",
      null,
    ]);
  });

  it("视图未返回快照授权版本时失败关闭", async () => {
    const { pool } = poolWithRows([]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() } as never);
    await expect(reader.read({ fence, toolVersionIds: ["outside"] })).rejects.toMatchObject({
      code: "EXTERNAL_TOOL_SNAPSHOT_INVALID",
    });
  });

  it("只有明确的撤销事实被归类为撤销，且不解密已撤销凭据", async () => {
    const { pool } = poolWithRows([{ ...row, revoked: true }]);
    const decrypt = vi.fn();
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt });
    await expect(reader.read({ fence, toolVersionIds: ["version-a"] })).rejects.toMatchObject({
      code: "EXTERNAL_TOOL_REVOKED",
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([
    { ...row, http_method: null },
    { ...row, source: "mcp" },
    { ...row, credential_configured: true },
    { ...row, ciphertext: "invalid-ciphertext" },
  ])("缺失方法或损坏密文归类为快照无效", async (invalidRow) => {
    const { pool } = poolWithRows([invalidRow]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() });
    await expect(reader.read({ fence, toolVersionIds: ["version-a"] })).rejects.toMatchObject({
      code: "EXTERNAL_TOOL_SNAPSHOT_INVALID",
    });
  });

  it("解密失败归类为快照无效且不传播秘密", async () => {
    const { pool } = poolWithRows([
      {
        ...row,
        credential_configured: true,
        cipher_version: 1,
        nonce: "placeholder-nonce",
        ciphertext: "placeholder-ciphertext",
        auth_tag: "placeholder-tag",
      },
    ]);
    const reader = new PgExternalToolSnapshotReader(pool, {
      decrypt: () => {
        throw new Error("placeholder-secret");
      },
    });
    await expect(reader.read({ fence, toolVersionIds: ["version-a"] })).rejects.toEqual(
      new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_INVALID"),
    );
  });

  it.each(["connect", "BEGIN", "set_config", "SELECT tool_version_id", "COMMIT"])(
    "%s 失败归类为存储不可用而非撤销",
    async (failurePoint) => {
      const { pool, query } = poolWithRows([row]);
      if (failurePoint === "connect") {
        pool.connect = vi.fn().mockRejectedValue(new Error("placeholder-secret"));
      } else {
        const original = query.getMockImplementation()!;
        query.mockImplementation(async (sql, values) => {
          if (sql.includes(failurePoint)) throw new Error("placeholder-secret");
          return original(sql, values);
        });
      }
      const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() });
      await expect(reader.read({ fence, toolVersionIds: ["version-a"] })).rejects.toEqual(
        new ExternalToolSnapshotError("EXTERNAL_TOOL_SNAPSHOT_UNAVAILABLE"),
      );
    },
  );

  it("重复版本和错配根 Run 在访问数据库之前拒绝", async () => {
    const { pool, query } = poolWithRows([row]);
    const reader = new PgExternalToolSnapshotReader(pool, { decrypt: vi.fn() });
    await expect(
      reader.read({ fence, toolVersionIds: ["version-a", "version-a"] }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    await expect(
      reader.read({
        fence: {
          ...fence,
          workspaceLease: { ...fence.workspaceLease, rootRunId: runId("other-run") },
        },
        toolVersionIds: ["version-a"],
      }),
    ).rejects.toMatchObject({ code: "EXTERNAL_TOOL_SNAPSHOT_INVALID" });
    expect(query).not.toHaveBeenCalled();
    await expect(reader.read({ fence, toolVersionIds: [] })).resolves.toEqual([]);
  });
});
