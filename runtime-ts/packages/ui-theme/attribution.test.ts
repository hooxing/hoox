// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { showHooxAttribution } from "./attribution.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("同一文档只输出一次署名，模块重新求值不会重复输出", async () => {
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  showHooxAttribution();
  showHooxAttribution();
  vi.resetModules();
  const reloaded = await import("./attribution.js");
  reloaded.showHooxAttribution();

  expect(info).toHaveBeenCalledExactlyOnceWith(
    "%cHoox%c\n本站基于开源项目 Hoox 构建\nhttps://github.com/hooxing/hoox",
    expect.stringContaining("background:"),
    "",
  );

  vi.stubGlobal("document", document.implementation.createHTMLDocument());
  reloaded.showHooxAttribution();
  expect(info).toHaveBeenCalledTimes(2);
});
