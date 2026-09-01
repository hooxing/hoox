// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const theme = readFileSync(fileURLToPath(new URL("./theme.css", import.meta.url)), "utf8");
const declarations = new Map(
  [...theme.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/gu)].map((match) => [match[1], match[2]]),
);

type Rgb = readonly [number, number, number];

function resolveToken(name: string): string {
  const value = declarations.get(name);
  if (value === undefined) throw new Error(`缺少主题 Token：${name}`);
  const reference = /^var\((--[a-z0-9-]+)\)$/u.exec(value);
  return reference?.[1] === undefined ? value : resolveToken(reference[1]);
}

function hslToRgb(value: string): Rgb {
  const match = /^hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
    throw new Error(`无法解析 HSL：${value}`);
  }
  const hue = Number(match[1]) / 360;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  if (saturation === 0) return [lightness, lightness, lightness];
  const q =
    lightness < 0.5
      ? lightness * (1 + saturation)
      : lightness + saturation - lightness * saturation;
  const p = 2 * lightness - q;
  const channel = (offset: number) => {
    const position = (hue + offset + 1) % 1;
    if (position < 1 / 6) return p + (q - p) * 6 * position;
    if (position < 1 / 2) return q;
    if (position < 2 / 3) return p + (q - p) * (2 / 3 - position) * 6;
    return p;
  };
  return [channel(1 / 3), channel(0), channel(-1 / 3)];
}

function luminance(rgb: Rgb): number {
  const [red, green, blue] = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as unknown as Rgb;
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(foreground: string, background: string): number {
  const foregroundLuminance = luminance(hslToRgb(resolveToken(foreground)));
  const backgroundLuminance = luminance(hslToRgb(resolveToken(background)));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("共享 UI 主题", () => {
  it("为两个应用提供稳定的语义角色", () => {
    for (const token of [
      "--surface-page",
      "--surface-sidebar",
      "--surface-hover",
      "--text-primary",
      "--text-secondary",
      "--border-strong",
      "--action-primary",
      "--focus-color",
      "--status-error-text",
    ]) {
      expect(declarations.has(token)).toBe(true);
    }
  });

  it("普通文字、主要操作和浅色状态满足 4.5:1", () => {
    for (const [foreground, background] of [
      ["--text-primary", "--surface-page"],
      ["--text-secondary", "--surface-page"],
      ["--text-tertiary", "--surface-page"],
      ["--action-primary-text", "--action-primary"],
      ["--action-subtle-text", "--action-subtle"],
      ["--status-info-text", "--status-info-surface"],
      ["--status-success-text", "--status-success-surface"],
      ["--status-warning-text", "--status-warning-surface"],
      ["--status-error-text", "--status-error-surface"],
    ] as const) {
      expect(
        contrast(foreground, background),
        `${foreground} / ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("功能边框在抬升表面上满足 3:1", () => {
    expect(contrast("--border-strong", "--surface-raised")).toBeGreaterThanOrEqual(3);
  });
});
