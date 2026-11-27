// @vitest-environment jsdom

import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PlatformBuildInfo } from "./platform-build-info.js";
import { render, settle } from "./testing/admin-component.js";

function trigger(container: HTMLElement) {
  const button = container.querySelector("button");
  if (button === null) throw new Error("未找到构建信息按钮");
  return button;
}

describe("后台构建信息", () => {
  it("侧栏显示版本、7 位 SHA 和 Demo 发布 ID，点开后可核对完整信息", async () => {
    const sha = `7654321${"a".repeat(33)}`;
    const builtAt = "2026-11-26T12:00:00.000Z";
    vi.stubGlobal("__HOOX_BUILD_INFO__", { version: "1.2.3", sha, builtAt });
    const container = render(<PlatformBuildInfo collapsed={false} releaseId="demo-42" />);
    const button = trigger(container);
    expect(button.textContent).toContain("v1.2.3 · 7654321");
    expect(button.textContent).toContain("Demo：demo-42");
    expect(button.textContent).not.toContain(sha);
    expect(button.getAttribute("aria-expanded")).toBe("false");

    act(() => button.click());
    await settle();

    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain(sha);
    expect(document.querySelector("time")?.getAttribute("datetime")).toBe(builtAt);
    expect(document.body.textContent).toContain("Demo 发布 ID");
  });

  it("未注入构建数据时显示回退文本，并省略未提供的发布 ID", async () => {
    vi.stubGlobal("__HOOX_BUILD_INFO__", undefined);
    const container = render(<PlatformBuildInfo collapsed={false} releaseId={undefined} />);
    const button = trigger(container);
    expect(button.textContent).toBe("dev · unknown");
    act(() => button.click());
    await settle();
    expect(document.body.textContent).toContain("构建时间（UTC）未知");
    expect(document.body.textContent).not.toContain("Demo");
  });
});
