import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 白标允许任意可读主色；以主色为背景的规则必须使用自动计算的前景色，不能写死白色。
const stylesheets = [
  "runtime-ts/apps/web/src/styles.css",
  "runtime-ts/apps/web/src/file-preview.css",
  "runtime-ts/apps/admin-web/src/styles.css",
  "runtime-ts/packages/chat-ui/styles.css",
];

describe("品牌主色前景色契约", () => {
  it("以 --action-primary 为背景的规则都配对 --action-primary-text", async () => {
    const violations: string[] = [];
    for (const path of stylesheets) {
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      for (const block of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
        const body = block[2] ?? "";
        if (!/background(?:-color)?\s*:\s*var\(--action-primary\)/u.test(body)) continue;
        const color = /(?:^|[;\s])color\s*:\s*([^;]+);/u.exec(body)?.[1]?.trim();
        if (color !== undefined && color !== "var(--action-primary-text)")
          violations.push(`${path} ${block[1]?.trim()} → ${color}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
