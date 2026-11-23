import { describe, expect, it, vi } from "vitest";
import {
  clientToolsForSession,
  createClientTools,
  createPlaygroundClientToolMocks,
} from "./client-tools.js";

const definitions = [
  {
    name: "client_lookup",
    description: "查询客户端数据",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
] as const;

describe("Playground 客户端工具 Mock", () => {
  it("只向根 Session 暴露客户端工具", () => {
    expect(clientToolsForSession(definitions, "root")).toEqual(definitions);
    expect(clientToolsForSession(definitions, "subagent")).toEqual([]);
  });
  it("正式调用只暂存可由 PostgreSQL 表示且大小有界的 JSON 参数", async () => {
    const stage = vi.fn(() => true);
    const [tool] = createClientTools(definitions, {
      stage,
      recordReceipt: async () => undefined,
      persistStarted: async () => {},
    });
    if (!tool) throw new Error("缺少客户端工具");
    for (const key of ["\0", "\ud800", "界".repeat(6000)])
      expect((await tool.execute("rejected", { key })).details).toEqual({ pending: false });
    expect((await tool.execute("accepted", { key: "\\u0000" })).details).toEqual({ pending: true });
    expect(stage).toHaveBeenCalledOnce();
  });
  it("Playground 命中时持久化 Mock 回执而不访问真实客户端", async () => {
    const recordReceipt = vi.fn(async () => undefined);
    const persistStarted = vi.fn(async () => undefined);
    const tool = createPlaygroundClientToolMocks(definitions, {
      origin: "playground",
      mocks: { client_lookup: { result: "fake" } },
      recordReceipt,
      persistStarted,
    })[0];
    const result = await tool?.execute("call", { key: "x" });
    expect(result?.details).toEqual({ executionMode: "mock", mockResult: { result: "fake" } });
    expect(result?.content[0]).toMatchObject({ text: '[Playground Mock] {"result":"fake"}' });
    expect(recordReceipt).toHaveBeenCalledWith(
      "call",
      "client_lookup",
      "succeeded",
      "playground_mock",
    );
    expect(persistStarted).toHaveBeenCalledOnce();
  });

  it("Playground 客户端工具缺少 Mock 时失败关闭并记录失败回执", async () => {
    const recordReceipt = vi.fn(async () => undefined);
    const persistStarted = vi.fn(async () => undefined);
    const tool = createPlaygroundClientToolMocks(definitions, {
      origin: "playground",
      mocks: {},
      recordReceipt,
      persistStarted,
    })[0];
    const result = await tool?.execute("missing", { key: "x" });
    expect(result?.details).toEqual({ error: "PLAYGROUND_MOCK_NOT_CONFIGURED" });
    expect(recordReceipt).toHaveBeenCalledWith("missing", "client_lookup", "failed");
    expect(persistStarted).toHaveBeenCalledOnce();
  });

  it.each(["normal", "evaluation", "api"] as const)("%s Run 不读取 Mock", async (origin) => {
    let mockReads = 0;
    const mocks = new Proxy(
      { client_lookup: { result: "must-not-read" } },
      {
        getOwnPropertyDescriptor(target, key) {
          mockReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const recordReceipt = vi.fn(async () => undefined);
    const tool = createPlaygroundClientToolMocks(definitions, {
      origin,
      mocks,
      recordReceipt,
      persistStarted: async () => undefined,
    })[0];
    const result = await tool?.execute(`call-${origin}`, { key: "x" });
    expect(mockReads).toBe(0);
    expect(recordReceipt).toHaveBeenCalledWith(`call-${origin}`, "client_lookup", "failed");
    expect(result?.content[0]).toMatchObject({ text: "Playground 尚未为此客户端工具配置 Mock。" });
  });
});
