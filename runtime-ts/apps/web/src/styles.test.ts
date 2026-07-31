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
});
