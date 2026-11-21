import { describe, expect, it, vi } from "vitest";
import { createPlaygroundClientToolMocks } from "./client-tools.js";

const definitions = [
  {
    name: "client_lookup",
    description: "查询客户端数据",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
] as const;

describe("Playground 客户端工具 Mock", () => {
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
