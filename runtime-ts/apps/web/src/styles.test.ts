// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const styles = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("工作台滚动区域样式", () => {
  it("会话列表和运行内容保留滚动能力但不显示滚动条", () => {
    expect(styles).toMatch(
      /\.thread-list\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*none;/su,
    );
    expect(styles).toMatch(
      /\.run-area\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-width:\s*none;/su,
    );
    expect(styles).toContain(".thread-list::-webkit-scrollbar");
    expect(styles).toContain(".run-area::-webkit-scrollbar");
  });

  it("不再包含右侧活动栏布局", () => {
    expect(styles).not.toContain(".activity-panel");
    expect(styles).not.toContain(".activity-scroll");
  });

  it("桌面端使用轻量任务栏、窄正文和与输入框衔接的进度区", () => {
    expect(styles).toMatch(/grid-template-columns:\s*300px minmax\(0, 1fr\)/u);
    expect(styles).toMatch(/\.run-area\s*\{[^}]*width:\s*min\(100%, 810px\)/su);
    expect(styles).toMatch(/\.composer\s*\{[^}]*762px[^}]*border-radius:\s*20px/su);
    expect(styles).toContain(".run-progress-dock + .composer");
  });

  it("运行步骤保留横向进度轨道，思考文本使用单一可滚动披露区", () => {
    expect(styles).toMatch(
      /\.run-progress-track\s*\{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/su,
    );
    expect(styles).toContain(".run-progress-track::-webkit-scrollbar");
    expect(styles).not.toContain(".run-progress-disclosures");
    expect(styles).not.toContain(".run-progress-history");
    expect(styles).toMatch(/\.run-thinking\s*\{[^}]*border-top:/su);
    expect(styles).toMatch(
      /\.run-thinking-content\s*\{[^}]*max-height:\s*min\([^;]+;[^}]*overflow:\s*auto;/su,
    );
    expect(styles).toContain(".run-thinking[open] .when-expanded");
    expect(styles).toContain(".run-thinking-content:focus-visible");
  });
});
