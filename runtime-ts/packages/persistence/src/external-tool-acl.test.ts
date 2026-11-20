import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { activeColumnUpdatePolicy, activeTablePolicy } from "./role-bootstrap.js";

const migrationUrl = new URL("../migrations/0005_external_tools.up.sql", import.meta.url);
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
      /async function activeTablePolicy\([\s\S]*?if \(!\(await hasExternalToolState\(client, schema\)\)\) \{\s*for \(const table of \[/u,
    );
    expect(bootstrap).toMatch(
      /export async function activeColumnUpdatePolicy\([\s\S]*?if \(!\(await hasExternalToolState\(client, schema\)\)\) \{\s*for \(const table of \[/u,
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
