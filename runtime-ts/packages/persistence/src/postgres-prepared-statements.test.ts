import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { installPreparedStatementCache } from "./postgres.js";

function fakeClient() {
  const query = vi.fn((..._args: unknown[]) => Promise.resolve({ rows: [], rowCount: 0 }));
  const client = { query } as unknown as PoolClient;
  installPreparedStatementCache(client);
  const nameOf = (index: number) =>
    (query.mock.calls[index]?.[0] as { name?: string } | undefined)?.name;
  return { client, query, nameOf };
}

describe("预备语句缓存", () => {
  it("带参数的单语句按 SQL 文本哈希命名，同文本同名、不同文本不同名", async () => {
    const { client, query } = fakeClient();
    await client.query("SELECT * FROM runs WHERE tenant_id=$1", ["t1"]);
    await client.query("SELECT * FROM runs WHERE tenant_id=$1", ["t2"]);
    await client.query("SELECT * FROM threads WHERE tenant_id=$1", ["t1"]);
    const configs = query.mock.calls.map((call) => call[0] as { name: string; values: unknown });
    expect(configs[0]?.name).toMatch(/^hoox_[0-9a-f]{40}$/u);
    expect(configs[1]?.name).toBe(configs[0]?.name);
    expect(configs[1]?.values).toEqual(["t2"]);
    expect(configs[2]?.name).not.toBe(configs[0]?.name);
  });

  it("配置对象未指定名称时补齐名称，已有名称保持不变", async () => {
    const { client, nameOf } = fakeClient();
    await client.query({ text: "SELECT $1::text", values: ["a"] });
    await client.query({ name: "explicit", text: "SELECT $1::text", values: ["a"] });
    expect(nameOf(0)).toMatch(/^hoox_/u);
    expect(nameOf(1)).toBe("explicit");
  });

  it.each([
    ["无参数", "SELECT 1", undefined],
    ["空参数", "SELECT 1", []],
    ["多语句", "SET LOCAL a=$1; SELECT 1", ["x"]],
    ["dollar quote", "DO $$ BEGIN PERFORM $1; END $$", ["x"]],
  ])("%s 的查询原样透传", async (_label, text, values) => {
    const { client, query } = fakeClient();
    await (values === undefined ? client.query(text) : client.query(text, values));
    expect(query.mock.calls[0]?.[0]).toBe(text);
  });

  it("字符串字面量与注释中的分号不视为多语句", async () => {
    const { client, nameOf } = fakeClient();
    await client.query("SELECT ';x' AS v, $1::text -- a; b\n", ["x"]);
    expect(nameOf(0)).toMatch(/^hoox_/u);
  });

  it("回调与 Submittable 调用保持原样", async () => {
    const { client, query } = fakeClient();
    const callback = vi.fn();
    (client.query as unknown as (...args: unknown[]) => unknown)("SELECT $1", ["x"], callback);
    const submittable = { submit: vi.fn(), text: "SELECT $1", values: ["x"] };
    (client.query as unknown as (...args: unknown[]) => unknown)(submittable);
    expect(query.mock.calls[0]?.[0]).toBe("SELECT $1");
    expect(query.mock.calls[0]?.[2]).toBe(callback);
    expect(query.mock.calls[1]?.[0]).toBe(submittable);
  });
});
