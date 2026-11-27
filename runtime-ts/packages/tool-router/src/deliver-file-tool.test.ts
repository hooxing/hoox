import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { createDeliverFilePiTool } from "./deliver-file-tool.js";

describe("deliver_file Pi 工具", () => {
  it("模型描述只承诺可下载交付物，不声称模型可观察页面", async () => {
    const tool = createDeliverFilePiTool(
      {
        deliverFile: async () => ({ status: "published", download_ready: true }),
        projectError: () => ({
          status: "failed",
          code: "SERVICE_UNAVAILABLE",
          message: "暂不可用",
          correctable: false,
          fatal: false,
        }),
      },
      async () => ({ outcome: "recorded", observation: "recorded", isTruncated: false }),
    );
    expect(tool.description).toBe(
      "用户要求生成、导出或提供文件时，在 /workspace 写好最终文件后、回复用户前，调用本工具逐个交付。只写文件或在答复中给出路径不会让用户看到或下载文件。工具返回成功后，用户可从交付卡片打开文件。不要交付临时文件。",
    );
    expect(tool.description).not.toContain("页面");
    expect(tool.executionMode).toBe("sequential");
    const result = await tool.execute(
      "call-deliver",
      { path: "/workspace/report.pdf" },
      undefined,
      () => undefined,
    );
    expect(JSON.stringify(result)).toContain('\\"download_ready\\":true');
  });

  it("schema 级无效参数进入 durable 失败回执，不触碰 Router", async () => {
    let routerCalls = 0;
    const outcomes: string[] = [];
    const tool = createDeliverFilePiTool(
      {
        deliverFile: async () => {
          routerCalls += 1;
          return {};
        },
        projectError: () => ({
          status: "failed",
          code: "SERVICE_UNAVAILABLE",
          message: "暂不可用",
          correctable: false,
          fatal: false,
        }),
      },
      async (_callId, _toolName, outcome) => {
        outcomes.push(outcome);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
    );
    if (tool.prepareArguments === undefined) throw new Error("测试缺少 schema 参数桥");

    for (const [index, input] of [
      {},
      { path: 1 },
      { path: "/workspace/a", extra: true },
    ].entries()) {
      const prepared = tool.prepareArguments(input);
      expect(Value.Check(tool.parameters, prepared)).toBe(true);
      await expect(
        tool.execute(`call-deliver-invalid-${index}`, prepared, undefined, () => undefined),
      ).rejects.toThrow("INVALID_ARGUMENT");
    }

    expect(routerCalls).toBe(0);
    expect(outcomes).toEqual(["failed", "failed", "failed"]);
  });

  it("fatal Router 结果先写 durable 失败回执，再作为 Tool Error 返回模型", async () => {
    const order: string[] = [];
    const tool = createDeliverFilePiTool(
      {
        deliverFile: async () => {
          throw new Error("commit unknown");
        },
        projectError: () => ({
          status: "failed",
          code: "PUBLICATION_RESULT_UNKNOWN",
          message: "文件发布结果未知，需要恢复后确认",
          correctable: false,
          fatal: true,
        }),
      },
      async (_callId, _toolName, outcome) => {
        order.push(`receipt:${outcome}`);
        return { outcome: "recorded", observation: "recorded", isTruncated: false };
      },
    );

    await expect(
      tool.execute(
        "call-deliver-unknown",
        { path: "/workspace/report.pdf" },
        undefined,
        () => undefined,
      ),
    ).rejects.toThrow("PUBLICATION_RESULT_UNKNOWN");
    expect(order).toEqual(["receipt:failed"]);
  });
});
