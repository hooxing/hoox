import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const applications = ["api", "agent-worker", "scheduler", "admin-control-api"] as const;

describe("development 本地配置真源", () => {
  it.each(applications)(
    "%s 常驻入口由代码加载根 .env，不再接受 Node 的继承值优先级",
    async (application) => {
      const [manifestText, main] = await Promise.all([
        readFile(
          new URL(`../runtime-ts/apps/${application}/package.json`, import.meta.url),
          "utf8",
        ),
        readFile(
          new URL(`../runtime-ts/apps/${application}/src/development-main.ts`, import.meta.url),
          "utf8",
        ),
      ]);
      const manifest = JSON.parse(manifestText) as { readonly scripts?: Record<string, string> };

      expect(manifest.scripts?.dev).not.toContain("--env-file");
      expect(main).toContain("loadDevelopmentEnvironment");
      expect(main).toContain('new URL("../../../../.env", import.meta.url)');
    },
  );

  it("API 身份初始化与 Worker 预检使用相同加载规则", async () => {
    const [identity, preflight] = await Promise.all([
      readFile(
        new URL("../runtime-ts/apps/api/src/development-identity-main.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../runtime-ts/apps/agent-worker/src/development-preflight-main.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);

    expect(identity).toContain("loadDevelopmentEnvironment");
    expect(preflight).toContain("loadDevelopmentEnvironment");
  });
});
