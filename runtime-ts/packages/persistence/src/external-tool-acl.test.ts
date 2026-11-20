import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
      /async function activeColumnUpdatePolicy\([\s\S]*?if \(!\(await hasExternalToolState\(client, schema\)\)\) \{\s*for \(const table of \[/u,
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
});
