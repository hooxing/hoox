import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadMigrations } from "./migrations.js";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
const historicalUp = migration("0068_runtime_tool_selection_configuration.up.sql");
const historicalDown = migration("0068_runtime_tool_selection_configuration.down.sql");
const up = migration("0069_runtime_tool_selection_inline_constraint.up.sql");
const down = migration("0069_runtime_tool_selection_inline_constraint.down.sql");
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "").trim();
const oldConstraint = historicalUp.slice(historicalUp.indexOf("ALTER TABLE"));
const inlineConstraint = up.slice(up.indexOf("ALTER TABLE"), up.indexOf("\nDROP FUNCTION")).trim();
const guard =
  /CASE WHEN jsonb_typeof\(configuration->'enabledTools'\)='array' THEN \([\s\S]*?ELSE FALSE END/.exec(
    inlineConstraint,
  )?.[0];

describe("工具选择内联约束迁移", () => {
  it("只替换校验实现，完整保留 0068 其他配置约束", () => {
    expect(guard).toBeDefined();
    expect(
      inlineConstraint.replace(
        guard ?? "",
        "runtime_tool_selection_is_valid(configuration->'enabledTools')",
      ),
    ).toBe(oldConstraint.trim());
    expect(withoutComments(up)).not.toMatch(
      /\b(?:CREATE FUNCTION|CREATE PROCEDURE|CREATE AGGREGATE|SELECT|UPDATE|INSERT|DELETE|TRUNCATE)\b/i,
    );
    expect(up.indexOf("ADD CONSTRAINT")).toBeLessThan(up.indexOf("DROP FUNCTION"));
    expect(withoutComments(up)).toMatch(/DROP FUNCTION runtime_tool_selection_is_valid\(jsonb\);$/);
  });

  it("CASE 先拒绝非数组，去除已知字符串后必须为空，长度等于不同名称数量", async () => {
    const { RUNTIME_TOOL_CATALOG } = await vi.importActual<{
      readonly RUNTIME_TOOL_CATALOG: readonly { readonly name: string }[];
    }>("@hoox/protocol");
    const catalog = RUNTIME_TOOL_CATALOG.map((tool) => tool.name);
    const array = /-ARRAY\[([\s\S]*?)\]/.exec(guard ?? "")?.[1] ?? "";
    expect([...array.matchAll(/'([a-z_]+)'/g)].map((match) => match[1])).toEqual(catalog);
    expect(
      [...(guard ?? "").matchAll(/\? '([a-z_]+)'\)::integer/g)].map((match) => match[1]),
    ).toEqual(catalog);
    expect(guard).toContain("]='[]'::jsonb");
    expect(guard).toContain("jsonb_array_length(configuration->'enabledTools')=(");
    expect(guard).toMatch(/^CASE WHEN jsonb_typeof[\s\S]*ELSE FALSE END$/);
    expect(guard).not.toMatch(/\bCOALESCE\b|jsonb_array_elements/);
  });

  it("down 逐字恢复 0068 中间态，整批迁移入口负责禁止 routine 状态提交", () => {
    expect(down.endsWith(historicalUp)).toBe(true);
    expect(withoutComments(down)).toBe(withoutComments(historicalUp));
    expect(historicalDown).toContain("DROP FUNCTION runtime_tool_selection_is_valid(jsonb);");
  });

  it("冻结已提交 0068 字节和 checksum，新增成对 0069", async () => {
    expect(createHash("sha256").update(historicalUp).digest("hex")).toBe(
      "6dc21a91b1f52e5507f778ac3a5f3cddc0821a34dac6287893412c4409234711",
    );
    expect(createHash("sha256").update(historicalDown).digest("hex")).toBe(
      "27ec1b1ebdc8f0be5151898a72fcb3cbb5d0a44ee3cf2e5407b84a5ed0bce4b0",
    );
    const migrations = await loadMigrations();
    expect(migrations.find((source) => source.version === 68)?.checksum).toBe(
      "98d68cabec633a8933b3b8fe1fbc639aaef4aa45d2cd95dc7acc3c9d18ff7230",
    );
    expect(migrations.find((source) => source.version === 69)).toMatchObject({
      name: "runtime_tool_selection_inline_constraint",
      upSql: up,
      downSql: down,
    });
  });
});
