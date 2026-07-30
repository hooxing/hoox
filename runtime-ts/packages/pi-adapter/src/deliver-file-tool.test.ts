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
        }),
      },
      async () => ({ outcome: "recorded", observation: "recorded", isTruncated: false }),
    );
    expect(tool.description).toBe(
      "将 CubeSandbox 中已经生成的文件作为本次任务的交付文件提供给用户。仅当文件已成功保存为可下载交付物时返回成功。",
    );
    expect(tool.description).not.toContain("页面");
    const result = await tool.execute(
      "call-deliver",
      { path: "/workspace/report.pdf" },
      undefined,
      () => undefined,
      {} as never,
    );
    expect(JSON.stringify(result)).toContain('\\"download_ready\\":true');
  });
});
