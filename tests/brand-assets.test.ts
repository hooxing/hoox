import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const expectedAssets = {
  "hoox-app-icon.png": { width: 1254, height: 1254 },
  "hoox-primary-horizontal.png": { width: 1916, height: 821 },
  "hoox-reversed-horizontal.png": { width: 1925, height: 817 },
  "hoox-symbol.png": { width: 1254, height: 1254 },
} as const;

function pngDimensions(content: Buffer): { readonly width: number; readonly height: number } {
  expect(content.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(content.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: content.readUInt32BE(16), height: content.readUInt32BE(20) };
}

describe("Hoox 品牌资产", () => {
  for (const [name, dimensions] of Object.entries(expectedAssets)) {
    it(`${name} 保持已确认的 PNG 尺寸`, async () => {
      const content = await readFile(
        new URL(`../runtime-ts/public/brand/${name}`, import.meta.url),
      );
      expect(pngDimensions(content)).toEqual(dimensions);
      expect(content.byteLength).toBeGreaterThan(500_000);
    });
  }

  it("Web 与 Admin Web 共享品牌目录并声明同一个站点图标", async () => {
    const [webConfig, adminConfig, webHtml, adminHtml] = await Promise.all([
      readFile(new URL("../runtime-ts/apps/web/vite.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/admin-web/vite.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/admin-web/index.html", import.meta.url), "utf8"),
    ]);
    for (const config of [webConfig, adminConfig]) {
      expect(config).toContain('publicDir: resolve(import.meta.dirname, "../../public")');
    }
    for (const html of [webHtml, adminHtml]) {
      expect(html).toContain('href="/brand/hoox-app-icon.png"');
    }
  });
});
