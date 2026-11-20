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

  it("0001+0002 实际建表集合与 A1/D1/B1 不存在时的 Runtime 表键完全一致", async () => {
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
  it("0001+0002 不预期 API Key 表或函数，完整迁移后才加入对应白名单", async () => {
    for (const apiKeyState of [false, true]) {
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: [
            {
              present:
                sql.includes("api_keys") || sql.includes("revoke_api_key") ? apiKeyState : false,
            },
          ],
        })),
      } as unknown as PoolClient;

      const tables = await activeTablePolicy(client, "it_api_key_policy");
      const columns = await activeColumnUpdatePolicy(client, "it_api_key_policy");
      expect(tables.has("api_keys")).toBe(apiKeyState);
      expect(columns.has("api_keys")).toBe(apiKeyState);
      if (apiKeyState) expect(columns.get("api_keys")).toEqual(new Set(["last_used_at"]));
      else expect(columns.get("api_keys")).toBeUndefined();
    }
  });

  it("表 ACL 与撤销函数 EXECUTE 分别按各自对象存在性授予", async () => {
    const bootstrap = await readFile(bootstrapUrl, "utf8");
    expect(bootstrap).toMatch(
      /if \(await hasApiKeyState\(client, context\.schema\)\) \{\s*await client\.query\([\s\S]*?GRANT SELECT, INSERT ON TABLE \$\{schema\}\.api_keys TO \$\{role\};\s*GRANT UPDATE\(last_used_at\) ON TABLE \$\{schema\}\.api_keys TO \$\{role\}/u,
    );
    expect(bootstrap).toMatch(
      /if \(await hasApiKeyRoutineState\(client, context\.schema\)\) \{\s*await client\.query\(\s*`GRANT EXECUTE ON FUNCTION \$\{schema\}\.revoke_api_key/u,
    );
    expect(bootstrap).toMatch(
      /async function hasApiKeyRoutineState\([\s\S]*?proname = 'revoke_api_key'[\s\S]*?proargtypes\[0\] = 'text'::regtype[\s\S]*?proargtypes\[1\] = 'timestamptz'::regtype/u,
    );
  });
});
