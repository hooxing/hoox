import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertThreadActiveHistory as assertFromRoot,
  threadActiveHistoryDigest as digestFromRoot,
} from "@hoox/pi-adapter";
import {
  assertThreadActiveHistory,
  threadActiveHistoryDigest,
  type ThreadActiveHistoryV1,
} from "@hoox/pi-adapter/thread-history";
import {
  assertThreadActiveHistory as assertFromContracts,
  threadActiveHistoryDigest as digestFromContracts,
} from "@hoox/run-contracts";
import { describe, expect, it } from "vitest";

describe("Run 契约的历史入口", () => {
  it("保留根入口兼容性及历史校验语义", () => {
    expect(assertFromContracts).toBe(assertThreadActiveHistory);
    expect(assertFromRoot).toBe(assertThreadActiveHistory);
    expect(digestFromContracts).toBe(threadActiveHistoryDigest);
    expect(digestFromRoot).toBe(threadActiveHistoryDigest);

    const unsigned: Omit<ThreadActiveHistoryV1, "digest"> = {
      schemaVersion: 1,
      projectionSchemaVersion: 1,
      throughSequence: 1,
      messages: [{ sequence: 1, role: "user", text: "历史正文", timestamp: 1 }],
    };
    const history = { ...unsigned, digest: digestFromContracts(unsigned) };
    expect(() => assertFromContracts(history)).not.toThrow();
    expect(() => assertFromContracts({ ...history, digest: "0".repeat(64) })).toThrow(
      "Thread Active History digest 不匹配",
    );
    expect(() =>
      assertFromContracts({
        ...history,
        messages: [{ sequence: 2, role: "user", text: "越界正文", timestamp: 1 }],
      }),
    ).toThrow("Thread Active History 顺序无效");
  });

  it("独立进程导入公开契约不会加载 Pi 适配器、Sandbox Provider 或模型 SDK", () => {
    // 仅为 Workspace 启用 types 条件并运行当前源码，避免旧 dist 和第三方声明文件干扰。
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
          import assert from "node:assert/strict";
          import { existsSync } from "node:fs";
          import { registerHooks } from "node:module";

          const loaded = new Set();
          registerHooks({
            resolve(specifier, context, nextResolve) {
              if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
                const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
                if (existsSync(source)) specifier = source.href;
              }
              const result = nextResolve(specifier, specifier.startsWith("@hoox/")
                ? { ...context, conditions: ["types", ...context.conditions] }
                : context);
              const url = new URL(result.url);
              const path = decodeURIComponent(url.pathname).replaceAll("\\\\", "/");
              if (
                specifier.startsWith("@earendil-works/") ||
                specifier.startsWith("@huggingface/") ||
                specifier.startsWith("@cubesandbox/") ||
                specifier === "e2b" ||
                path.includes("/sandbox/src/") ||
                (path.includes("/pi-adapter/src/") && !path.endsWith("/thread-history.ts"))
              ) {
                throw new Error("禁止加载模型运行时: " + specifier);
              }
              loaded.add(path);
              return result;
            },
          });

          const contracts = await import("@hoox/run-contracts");
          // run-contracts 自身不得触达 pi-adapter；兼容入口只在显式导入时加载。
          assert(![...loaded].some(path => path.includes("/pi-adapter/")));
          assert([...loaded].some(path => path.endsWith("/run-contracts/src/thread-history.ts")));
          const history = await import("@hoox/pi-adapter/thread-history");
          assert.equal(contracts.assertThreadActiveHistory, history.assertThreadActiveHistory);
          assert.equal(contracts.threadActiveHistoryDigest, history.threadActiveHistoryDigest);
          assert([...loaded].some(path => path.endsWith("/run-contracts/src/index.ts")));
          assert([...loaded].some(path => path.endsWith("/pi-adapter/src/thread-history.ts")));

          // 负对照必须实际被拦截，证明隔离进程中的模块守卫确实生效。
          await assert.rejects(import("@hoox/pi-adapter"), /禁止加载模型运行时/u);
          await assert.rejects(import("@hoox/sandbox"), /禁止加载模型运行时/u);
          await assert.rejects(import("@earendil-works/pi-ai"), /禁止加载模型运行时/u);
          process.stdout.write("ok");
        `,
      ],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
        windowsHide: true,
      },
    );
    expect(output).toBe("ok");
  });
});
