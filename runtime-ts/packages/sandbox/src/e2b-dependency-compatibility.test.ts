import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Template } from "e2b";
import { describe, expect, it, vi } from "vitest";

describe("E2B 依赖升级兼容性", () => {
  it("真实模板 COPY 在升级 glob 后仍包含隐藏文件，并遵守忽略规则与内容哈希", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hoox-e2b-template-"));
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("本地模板不得联网"));
    try {
      mkdirSync(join(directory, "ignored"));
      writeFileSync(join(directory, "visible.txt"), "visible-v1");
      writeFileSync(join(directory, ".hidden"), "hidden-v1");
      writeFileSync(join(directory, "ignored", "skip.txt"), "ignored-v1");
      const template = Template({
        fileContextPath: directory,
        fileIgnorePatterns: ["ignored/**"],
      })
        .fromImage("alpine:3.22")
        .copy(".", "/app");
      const hash = async () => {
        const data = JSON.parse(await Template.toJSON(template, true)) as {
          steps: { type: string; filesHash?: string }[];
        };
        const value = data.steps.find((step) => step.type === "COPY")?.filesHash;
        expect(value).toMatch(/^[a-f0-9]{64}$/u);
        return value;
      };
      const initial = await hash();
      writeFileSync(join(directory, "ignored", "skip.txt"), "ignored-v2");
      expect(await hash()).toBe(initial);
      writeFileSync(join(directory, ".hidden"), "hidden-v2");
      const hiddenChanged = await hash();
      expect(hiddenChanged).not.toBe(initial);
      writeFileSync(join(directory, "visible.txt"), "visible-v2");
      expect(await hash()).not.toBe(hiddenChanged);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
