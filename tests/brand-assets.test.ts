import { readFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const expectedAssets = {
  "apple-touch-icon-180.png": { width: 180, height: 180, colorType: 2 },
  "favicon-16.png": { width: 16, height: 16, colorType: 2 },
  "favicon-32.png": { width: 32, height: 32, colorType: 2 },
  "favicon-48.png": { width: 48, height: 48, colorType: 2 },
  "hoox-app-icon.png": { width: 1254, height: 1254 },
  "hoox-horizontal-transparent.png": { width: 1916, height: 821, colorType: 6 },
  "hoox-monochrome-black.png": { width: 1916, height: 821, colorType: 6 },
  "hoox-monochrome-white.png": { width: 1916, height: 821, colorType: 6 },
  "hoox-open-graph.png": { width: 1200, height: 630, colorType: 2 },
  "hoox-primary-horizontal.png": { width: 1916, height: 821 },
  "hoox-reversed-horizontal.png": { width: 1925, height: 817 },
  "hoox-symbol.png": { width: 1254, height: 1254 },
  "hoox-symbol-transparent.png": { width: 1254, height: 1254, colorType: 6 },
  "pwa-icon-192.png": { width: 192, height: 192, colorType: 2 },
  "pwa-icon-512.png": { width: 512, height: 512, colorType: 2 },
  "pwa-icon-maskable-512.png": { width: 512, height: 512, colorType: 2 },
} as const;

type Png = {
  readonly width: number;
  readonly height: number;
  readonly colorType: number;
  readonly bytesPerPixel: number;
  readonly pixels: Buffer;
};

function paethPredictor(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(content: Buffer): Png {
  expect(content.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(content.subarray(12, 16).toString("ascii")).toBe("IHDR");
  const width = content.readUInt32BE(16);
  const height = content.readUInt32BE(20);
  expect(content[24]).toBe(8);
  const colorType = content[25] ?? -1;
  expect([2, 6]).toContain(colorType);
  expect(content[28]).toBe(0);
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const compressed: Buffer[] = [];
  for (let offset = 8; offset < content.length; ) {
    const length = content.readUInt32BE(offset);
    const type = content.subarray(offset + 4, offset + 8).toString("ascii");
    if (type === "IDAT") compressed.push(content.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(compressed));
  const stride = width * bytesPerPixel;
  expect(raw.length).toBe((stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? -1;
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(filter).toBeLessThanOrEqual(4);
    for (let column = 0; column < stride; column += 1) {
      const encoded = raw[row * (stride + 1) + column + 1] ?? 0;
      const target = row * stride + column;
      const left = column >= bytesPerPixel ? (pixels[target - bytesPerPixel] ?? 0) : 0;
      const above = row > 0 ? (pixels[target - stride] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel ? (pixels[target - stride - bytesPerPixel] ?? 0) : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? above
              : filter === 3
                ? Math.floor((left + above) / 2)
                : paethPredictor(left, above, upperLeft);
      pixels[target] = (encoded + predictor) & 0xff;
    }
  }
  return { width, height, colorType, bytesPerPixel, pixels };
}

function pixel(png: Png, x: number, y: number): readonly number[] {
  const offset = (y * png.width + x) * png.bytesPerPixel;
  return [...png.pixels.subarray(offset, offset + png.bytesPerPixel)];
}

describe("Hoox 品牌资产", () => {
  for (const [name, dimensions] of Object.entries(expectedAssets)) {
    it(`${name} 保持已确认的 PNG 尺寸`, async () => {
      const content = await readFile(
        new URL(`../runtime-ts/public/brand/${name}`, import.meta.url),
      );
      const png = decodePng(content);
      expect({ width: png.width, height: png.height }).toEqual({
        width: dimensions.width,
        height: dimensions.height,
      });
      if ("colorType" in dimensions) expect(png.colorType).toBe(dimensions.colorType);
    });
  }

  it("四个原始 PNG 保持 RGB、尺寸和最低文件量级", async () => {
    for (const name of [
      "hoox-app-icon.png",
      "hoox-primary-horizontal.png",
      "hoox-reversed-horizontal.png",
      "hoox-symbol.png",
    ]) {
      const content = await readFile(
        new URL(`../runtime-ts/public/brand/${name}`, import.meta.url),
      );
      expect(decodePng(content).colorType).toBe(2);
      expect(content.byteLength).toBeGreaterThan(500_000);
    }
  });

  it("透明与单色资产具有真实 Alpha，单色前景不含灰色污染", async () => {
    for (const name of ["hoox-horizontal-transparent.png", "hoox-symbol-transparent.png"]) {
      const png = decodePng(
        await readFile(new URL(`../runtime-ts/public/brand/${name}`, import.meta.url)),
      );
      let hasTransparent = false;
      let hasOpaque = false;
      let hasPartial = false;
      for (let offset = 3; offset < png.pixels.length; offset += 4) {
        const alpha = png.pixels[offset] ?? 0;
        hasTransparent ||= alpha === 0;
        hasOpaque ||= alpha === 255;
        hasPartial ||= alpha > 0 && alpha < 255;
      }
      expect({ hasTransparent, hasOpaque, hasPartial }).toEqual({
        hasTransparent: true,
        hasOpaque: true,
        hasPartial: true,
      });
    }
    for (const [name, channel] of [
      ["hoox-monochrome-black.png", 0],
      ["hoox-monochrome-white.png", 255],
    ] as const) {
      const png = decodePng(
        await readFile(new URL(`../runtime-ts/public/brand/${name}`, import.meta.url)),
      );
      let visiblePixels = 0;
      let polluted = false;
      for (let offset = 0; offset < png.pixels.length; offset += 4) {
        const alpha = png.pixels[offset + 3] ?? 0;
        if (alpha === 0) continue;
        visiblePixels += 1;
        polluted ||=
          png.pixels[offset] !== channel ||
          png.pixels[offset + 1] !== channel ||
          png.pixels[offset + 2] !== channel;
      }
      expect(visiblePixels).toBeGreaterThan(0);
      expect(polluted).toBe(false);
    }
  });

  it("Maskable 前景位于中心 80% 安全圆内，OG 保持纸白画布", async () => {
    const maskable = decodePng(
      await readFile(
        new URL("../runtime-ts/public/brand/pwa-icon-maskable-512.png", import.meta.url),
      ),
    );
    const background = pixel(maskable, 0, 0);
    let maximumRadius = 0;
    for (let y = 0; y < maskable.height; y += 1) {
      for (let x = 0; x < maskable.width; x += 1) {
        const offset = (y * maskable.width + x) * maskable.bytesPerPixel;
        const distance =
          Math.abs((maskable.pixels[offset] ?? 0) - (background[0] ?? 0)) +
          Math.abs((maskable.pixels[offset + 1] ?? 0) - (background[1] ?? 0)) +
          Math.abs((maskable.pixels[offset + 2] ?? 0) - (background[2] ?? 0));
        if (distance < 36) continue;
        maximumRadius = Math.max(maximumRadius, Math.hypot(x + 0.5 - 256, y + 0.5 - 256));
      }
    }
    expect(maximumRadius).toBeLessThanOrEqual(512 * 0.4);

    const openGraph = decodePng(
      await readFile(new URL("../runtime-ts/public/brand/hoox-open-graph.png", import.meta.url)),
    );
    for (const [x, y] of [
      [0, 0],
      [openGraph.width - 1, 0],
      [0, openGraph.height - 1],
      [openGraph.width - 1, openGraph.height - 1],
    ] as const) {
      expect(pixel(openGraph, x, y)).toEqual([250, 249, 248]);
    }
  });

  it("Web 与 Admin Web 共享品牌目录并引用固定尺寸入口图标", async () => {
    const [webConfig, adminConfig, webHtml, adminHtml, manifest] = await Promise.all([
      readFile(new URL("../runtime-ts/apps/web/vite.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/admin-web/vite.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/apps/admin-web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../runtime-ts/public/manifest.webmanifest", import.meta.url), "utf8"),
    ]);
    for (const config of [webConfig, adminConfig]) {
      expect(config).toContain('publicDir: resolve(import.meta.dirname, "../../public")');
    }
    for (const html of [webHtml, adminHtml]) {
      expect(html).toContain('href="/brand/favicon-16.png"');
      expect(html).toContain('href="/brand/favicon-32.png"');
      expect(html).toContain('href="/brand/favicon-48.png"');
      expect(html).toContain('href="/brand/apple-touch-icon-180.png"');
    }
    expect(webHtml).toContain('href="/manifest.webmanifest"');
    expect(manifest).toContain('"src": "brand/pwa-icon-192.png"');
    expect(manifest).toContain('"src": "brand/pwa-icon-512.png"');
    expect(manifest).toContain('"src": "brand/pwa-icon-maskable-512.png"');
  });
});
