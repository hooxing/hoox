import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  activeColumnUpdatePolicy,
  activeTablePolicy,
  formatTableSetDifference,
} from "./role-bootstrap.js";

const migrationUrl = new URL("../migrations/0005_external_tools.up.sql", import.meta.url);
const baselineMigrationUrl = new URL("../migrations/0001_baseline.up.sql", import.meta.url);
const secondMigrationUrl = new URL(
  "../migrations/0002_inline_tool_receipts.up.sql",
  import.meta.url,
);
const bootstrapUrl = new URL("./role-bootstrap.ts", import.meta.url);

describe("外部工具 Admin Control ACL", () => {
  it("迁移权限、bootstrap 重授权与边界白名单保持一致", async () => {
    const [migration, bootstrap] = await Promise.all([
      readFile(migrationUrl, "utf8"),
      readFile(bootstrapUrl, "utf8"),
    ]);

    expect(migration).toMatch(
      /GRANT SELECT, INSERT ON external_tool_versions, external_tool_revocations TO %I/iu,
    );
    expect(migration).toMatch(/GRANT INSERT ON external_tool_credentials TO %I/iu);
    expect(bootstrap).toMatch(
      /GRANT SELECT,INSERT ON TABLE \$\{schema\}\.external_tool_versions,\$\{schema\}\.external_tool_revocations TO \$\{control\}/u,
    );
    expect(bootstrap).toMatch(
      /GRANT INSERT ON TABLE \$\{schema\}\.external_tool_credentials TO \$\{control\}/u,
    );
    expect(bootstrap).toMatch(
      /async function hasExternalToolState\([\s\S]*?to_regclass\(format\('%I\.external_tool_versions'[\s\S]*?AND to_regclass\(format\('%I\.external_tool_credentials'[\s\S]*?AND to_regclass\(format\('%I\.external_tool_revocations'/u,
    );
    expect(bootstrap).toMatch(
      /if \(await hasExternalToolState\(client, context\.schema\)\) \{\s*await client\.query\(/u,
    );
    expect(bootstrap).toMatch(
      /if \(await hasExternalToolState\(client, context\.schema\)\) \{\s*for \(const \[table, policy, target\] of externalToolPolicyBindings\)/u,
    );
    expect(bootstrap).toMatch(
      /const externalToolsEnabled = enabled && \(await hasExternalToolState\(client, context\.schema\)\);\s*const sandboxEnabled/u,
    );
    expect(bootstrap).toMatch(
      /if \(externalToolsEnabled\) \{\s*allowed\.set\("external_tool_versions"/u,
    );
    expect(bootstrap).toMatch(
      /async function activeTablePolicy\([\s\S]*?if \(await hasExternalToolState\(client, schema\)\) \{\s*for \(const table of \[/u,
    );
    expect(bootstrap).toMatch(
      /export async function activeColumnUpdatePolicy\([\s\S]*?if \(await hasExternalToolState\(client, schema\)\) \{\s*for \(const table of \[/u,
    );
    expect(bootstrap).toMatch(
      /allowed\.set\("external_tool_versions", new Set\(\["SELECT", "INSERT"\]\)\)/u,
    );
    expect(bootstrap).toMatch(
      /allowed\.set\("external_tool_credentials", new Set\(\["INSERT"\]\)\)/u,
    );
    expect(bootstrap).toMatch(
      /allowed\.set\("external_tool_revocations", new Set\(\["SELECT", "INSERT"\]\)\)/u,
    );
  });

  it("表集合诊断按排序结果列出缺少和多出的表名", () => {
    expect(formatTableSetDifference(["threads", "runs"], ["runs", "external_tool_versions"])).toBe(
      "缺少 [threads]，多出 [external_tool_versions]",
    );
    expect(formatTableSetDifference(["runs"], ["runs"])).toBe("缺少 []，多出 []");
  });

  it("0001+0002 实际建表集合与 Agent、外部工具和 Run 浏览器迁移不存在时的 Runtime 表键完全一致", async () => {
    const migrationSql = await Promise.all([
      readFile(baselineMigrationUrl, "utf8"),
      readFile(secondMigrationUrl, "utf8"),
    ]);
    const actualTables = new Set(
      migrationSql.flatMap((sql) =>
        [
          ...sql.matchAll(
            /CREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/giu,
          ),
        ].map((match) => match[1] as string),
      ),
    );
    // migrateUp 自身创建此基础表；它同样属于 Runtime ACL 表集合检查范围。
    actualTables.add("runtime_schema_migrations");

    const client = {
      query: vi.fn(async (sql: string) => {
        const referencedTables = [...sql.matchAll(/format\('%I\.([a-z_][a-z0-9_]*)'/giu)].map(
          (match) => match[1] as string,
        );
        const relationName = /relation\.relname='([a-z_][a-z0-9_]*)'/iu.exec(sql)?.[1];
        if (relationName !== undefined) referencedTables.push(relationName);
        return {
          rows: [
            {
              present:
                referencedTables.length > 0 &&
                referencedTables.every((table) => actualTables.has(table)),
            },
          ],
        };
      }),
    } as unknown as PoolClient;

    const policy = await activeTablePolicy(client, "it_partial_migration");
    expect([...policy.keys()].sort()).toEqual([...actualTables].sort());
    expect(policy.has("run_agent_snapshots")).toBe(false);
    expect(
      (await activeColumnUpdatePolicy(client, "it_partial_migration")).has("run_agent_snapshots"),
    ).toBe(false);
  });

  it("Runtime 表键仅在外部工具三表齐备时纳入白名单", async () => {
    const externalTables = [
      "external_tool_versions",
      "external_tool_credentials",
      "external_tool_revocations",
    ];

    for (const externalToolsPresent of [false, true]) {
      const client = {
        query: vi.fn(async (sql: string) => {
          const isExternalToolsState =
            sql.includes("external_tool_versions") &&
            sql.includes("external_tool_credentials") &&
            sql.includes("external_tool_revocations");
          const isAdminControlState =
            sql.includes("platform_control_operators") &&
            sql.includes("admin_control_config_revisions") &&
            sql.includes("admin_control_active_configs") &&
            sql.includes("run_runtime_config_snapshots");
          return {
            rows: [
              {
                present: isExternalToolsState ? externalToolsPresent : isAdminControlState,
              },
            ],
          };
        }),
      } as unknown as PoolClient;

      const policy = await activeTablePolicy(client, "it_policy_test");
      const columnPolicy = await activeColumnUpdatePolicy(client, "it_policy_test");
      const externalPolicyTables = [...policy.keys()].filter((table) =>
        externalTables.includes(table),
      );
      const externalColumnTables = [...columnPolicy.keys()].filter((table) =>
        externalTables.includes(table),
      );
      const expectedTables = externalToolsPresent ? [...externalTables].sort() : [];
      expect(externalPolicyTables.sort()).toEqual(expectedTables);
      expect(externalColumnTables.sort()).toEqual(expectedTables);
      if (externalToolsPresent) {
        for (const table of externalTables) {
          expect(policy.get(table)?.size).toBe(0);
          expect(columnPolicy.get(table)?.size).toBe(0);
        }
      }
    }
  });
});

describe("API Key Runtime ACL 存在性门控", () => {
  it("0001+0002 不预期 API Key ACL，0006 状态存在后加入受限更新列", async () => {
    for (const apiKeyState of [false, true]) {
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: [
            sql.includes("policy_count")
              ? { policy_count: apiKeyState ? "2" : "0" }
              : { present: sql.includes("api_keys") ? apiKeyState : false },
          ],
        })),
      } as unknown as PoolClient;

      const tables = await activeTablePolicy(client, "it_api_key_policy");
      const columns = await activeColumnUpdatePolicy(client, "it_api_key_policy");
      expect(tables.has("api_keys")).toBe(apiKeyState);
      if (apiKeyState) {
        expect(columns.get("api_keys")).toEqual(new Set(["last_used_at", "revoked_at"]));
        expect(columns.get("memberships")).toEqual(new Set(["status"]));
      } else {
        expect(columns.has("api_keys")).toBe(false);
        expect(columns.get("memberships")).toEqual(new Set());
      }
    }
  });

  it("只在 API Key 状态存在时授予撤销列，并由 Runtime 专属 RESTRICTIVE 策略收口", async () => {
    const [bootstrap, migration] = await Promise.all([
      readFile(bootstrapUrl, "utf8"),
      readFile(new URL("../migrations/0006_api_keys.up.sql", import.meta.url), "utf8"),
    ]);
    expect(bootstrap).toMatch(
      /if \(await hasApiKeyState\(client, context\.schema\)\) \{\s*await client\.query\([\s\S]*?GRANT UPDATE\(last_used_at\) ON TABLE \$\{schema\}\.api_keys TO \$\{role\}/u,
    );
    expect(bootstrap).toMatch(
      /if \(await hasApiKeyRevocationPolicyState\(client, context\.schema\)\) \{\s*await client\.query\([\s\S]*?GRANT UPDATE\(revoked_at\) ON TABLE \$\{schema\}\.api_keys TO \$\{role\};\s*GRANT UPDATE\(status\) ON TABLE \$\{schema\}\.memberships TO \$\{role\}/u,
    );
    expect(migration).toMatch(
      /CREATE POLICY api_key_integration_membership_revoke ON memberships AS RESTRICTIVE FOR UPDATE TO %I/u,
    );
    // USING 不得引用集成身份：FOR SHARE/UPDATE 会施加 UPDATE 策略的 USING，
    // 人类成员的授权加锁必须继续命中；集成身份约束只出现在 WITH CHECK 中。
    expect(migration).toMatch(
      /USING \(tenant_id = [^\n]*\n\s*AND status = ''active''\)\s*WITH CHECK/u,
    );
    expect(migration).toMatch(
      /WITH CHECK[\s\S]*status = ''revoked''[\s\S]*kind = ''integration''/u,
    );
    expect(migration).toMatch(
      /CREATE POLICY api_key_revocation_guard ON api_keys AS RESTRICTIVE FOR UPDATE TO %I/u,
    );
    expect(migration).toMatch(/revoked_at IS NULL/iu);
  });
});
