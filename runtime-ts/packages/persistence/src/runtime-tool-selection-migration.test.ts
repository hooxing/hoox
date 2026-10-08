import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadMigrations } from "./migrations.js";

const migration = (name: string) =>
  readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");

const constraint = (sql: string) => {
  const start = sql.indexOf("ALTER TABLE admin_control_config_revisions DROP CONSTRAINT");
  const end = sql.indexOf("\nDROP FUNCTION", start);
  return sql.slice(start, end === -1 ? undefined : end).trim();
};

const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();
const withoutComments = (sql: string) => sql.replace(/--[^\n]*/g, "");
const up = migration("0068_runtime_tool_selection_configuration.up.sql");
const down = migration("0068_runtime_tool_selection_configuration.down.sql");
const previous = constraint(migration("0067_runtime_tool_calling_mode_configuration.up.sql"));
const helper = up.slice(0, up.indexOf("ALTER TABLE admin_control_config_revisions"));
const enumMatch = /tool #>> '\{\}' IN \(([\s\S]*?)\)/.exec(helper);
const sqlToolNames = [...(enumMatch?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);

const selectionGuard =
  "      AND (\n" +
  "        NOT (configuration ? 'enabledTools')\n" +
  "        OR runtime_tool_selection_is_valid(configuration->'enabledTools')\n" +
  "      )\n";

const toolNames = [
  "exec_command",
  "read",
  "edit",
  "write",
  "skill",
  "todo_write",
  "deliver_file",
  "automation_update",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
];

describe("运行设置工具选择迁移（无数据库契约）", () => {
  it("仅增加可选工具清单，逐字保留 0067 的全部模型、记忆、模式与运行参数约束", () => {
    const current = constraint(up);
    expect(current).toContain(selectionGuard);
    expect(current).toContain("'enabledTools','toolCallingMode','workerMaxConcurrentRuns'");
    expect(
      current
        .replace("'enabledTools','toolCallingMode'", "'toolCallingMode'")
        .replace(selectionGuard, ""),
    ).toBe(previous);
    expect(current.match(/enabledTools/g)).toHaveLength(3);
  });

  it("工具清单不进入必填字段，不回填默认值或修改任何历史数据", () => {
    const runtime = constraint(up).split("object_kind='runtime_settings'")[1];
    expect(runtime).toBeDefined();
    const required = /configuration \?& ARRAY\[([\s\S]*?)\]/.exec(runtime ?? "");
    expect(required?.[1]).toBeDefined();
    expect(required?.[1]).not.toContain("enabledTools");
    for (const sql of [up, down]) {
      expect(withoutComments(sql)).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|TRUNCATE|MERGE)\b/i);
      expect(withoutComments(sql)).not.toMatch(/\b(?:DROP TABLE|ALTER COLUMN|SET DEFAULT)\b/i);
      expect(sql).not.toMatch(/configuration\s*-\s*'enabledTools'/);
    }
  });

  it("辅助函数无权限提升且声明为 IMMUTABLE SQL，不用 STRICT 让 SQL NULL 绕过 CHECK", () => {
    expect(compact(withoutComments(helper))).toMatch(
      /^CREATE FUNCTION runtime_tool_selection_is_valid\(enabled_tools jsonb\) RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS \$\$/,
    );
    expect(withoutComments(helper)).not.toMatch(/\b(?:STRICT|SECURITY DEFINER)\b/i);
    expect(withoutComments(helper)).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|ALTER|DROP)\b/i);
  });

  it("CASE 先判断数组类型，拒绝 null、字符串、对象等非数组，而不提前展开 JSON", () => {
    const body = /AS \$\$([\s\S]*?)\$\$;/.exec(helper)?.[1];
    expect(body).toBeDefined();
    const shape = (body ?? "").replace(
      /tool #>> '\{\}' IN \(([\s\S]*?)\)/,
      "tool #>> '{}' IN (<catalog>)",
    );
    expect(compact(shape)).toBe(
      compact(`
        SELECT CASE
          WHEN jsonb_typeof(enabled_tools)='array' THEN (
            SELECT count(*) <= 14
              AND count(*)=count(DISTINCT tool)
              AND COALESCE(bool_and(
                CASE WHEN jsonb_typeof(tool)='string' THEN
                  tool #>> '{}' IN (<catalog>)
                ELSE FALSE END
              ), TRUE)
            FROM jsonb_array_elements(enabled_tools) AS selected(tool)
          )
          ELSE FALSE
        END;
      `),
    );
  });

  it("数组最多 14 项，拒绝重复与非字符串元素，空数组通过空集真值校验", () => {
    expect(helper).toContain("count(*) <= 14");
    expect(helper).toContain("count(*)=count(DISTINCT tool)");
    expect(helper).toContain("CASE WHEN jsonb_typeof(tool)='string' THEN");
    expect(helper).toContain("ELSE FALSE END");
    expect(helper).toContain("), TRUE)");
    expect(helper).not.toMatch(/count\(\*\)\s*(?:>=\s*1|>\s*0|BETWEEN)/);
  });

  it("SQL 枚举完整匹配共享 catalog，不接受未知工具名", async () => {
    // 通过测试别名读取共享源码，不为纯 SQL 的 persistence 增加运行时包依赖。
    const { RUNTIME_TOOL_CATALOG } = await vi.importActual<{
      readonly RUNTIME_TOOL_CATALOG: readonly { readonly name: string }[];
    }>("@hoox/protocol");
    expect(sqlToolNames).toEqual(toolNames);
    expect(sqlToolNames).toEqual(RUNTIME_TOOL_CATALOG.map((tool) => tool.name));
    expect(new Set(sqlToolNames).size).toBe(14);
  });

  it("CHECK 本身无子查询，先创建函数再安装依赖该函数的约束", () => {
    expect(constraint(up)).not.toMatch(/\b(?:SELECT|FROM)\b/i);
    expect(up.indexOf("CREATE FUNCTION")).toBeLessThan(up.indexOf("DROP CONSTRAINT"));
    expect(constraint(up).match(/runtime_tool_selection_is_valid\(/g)).toHaveLength(1);
    expect(withoutComments(up).match(/ALTER TABLE\s+(\w+)/g)).toEqual([
      "ALTER TABLE admin_control_config_revisions",
      "ALTER TABLE admin_control_config_revisions",
    ]);
  });

  it("down 先锁表并拒绝任何含字段的历史 Revision，再恢复 0067 约束，最后删除函数", () => {
    const steps = [
      "LOCK TABLE admin_control_config_revisions IN ACCESS EXCLUSIVE MODE;",
      "IF EXISTS (",
      "WHERE object_kind='runtime_settings' AND configuration ? 'enabledTools'",
      "RAISE EXCEPTION 'DOWN_MIGRATION_BLOCKED:runtime_tool_selection_configuration_exists';",
      "DROP CONSTRAINT admin_control_configuration_shape",
      "ADD CONSTRAINT admin_control_configuration_shape",
      "DROP FUNCTION runtime_tool_selection_is_valid(jsonb);",
    ].map((step) => down.indexOf(step));
    expect(steps.every((index) => index >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((left, right) => left - right));
    expect(constraint(down)).toBe(previous);
    const guard = down.slice(down.indexOf("IF EXISTS"), down.indexOf("DROP CONSTRAINT"));
    expect(guard).not.toContain("jsonb_array_length");
    expect(guard).not.toMatch(/(?:->>|->|=|<>)\s*'\[\]'/);
    expect(guard).toMatch(/configuration \? 'enabledTools'\s*\) THEN/);
    expect(compact(withoutComments(down))).toMatch(/^LOCK TABLE/);
  });

  it("新增成对 0068，保持已发布 0066 与 0067 的迁移 checksum", async () => {
    const migrations = await loadMigrations();
    expect(migrations.find((source) => source.version === 66)?.checksum).toBe(
      "e3cc49e569947cc035043749441ac0a4b22ca083a66a1bf13ffc768276c23361",
    );
    expect(migrations.find((source) => source.version === 67)?.checksum).toBe(
      "ff8bcf9f992c2b6a39fdce5a30436aa3ca5141d75724a91da66ac20796878645",
    );
    const selection = migrations.find((source) => source.version === 68);
    expect(selection?.name).toBe("runtime_tool_selection_configuration");
    expect(selection?.upSql).toBe(up);
    expect(selection?.downSql).toBe(down);
  });

  it.each([
    [
      "0066_runtime_ptc_dispatches.up.sql",
      "6fced9bb0b5154a6bdf1e46253290da6ba8515011db7dad7b2a23851619a8334",
    ],
    [
      "0066_runtime_ptc_dispatches.down.sql",
      "0e6cbba8ff2daa4278380623232f2da6dbea1fc7929cdde98e7e990cf69118f2",
    ],
    [
      "0067_runtime_tool_calling_mode_configuration.up.sql",
      "4522fec179e4ee09c554ed89a93438473f5a1721aadd051f7eb08ae11220613a",
    ],
    [
      "0067_runtime_tool_calling_mode_configuration.down.sql",
      "a2138417e16d0d6b45198f45a693cc26eda272c3bca374dbdd6faced4afb023d",
    ],
  ])("冻结历史迁移文件字节指纹：%s", (name, checksum) => {
    expect(createHash("sha256").update(migration(name)).digest("hex")).toBe(checksum);
  });
});
