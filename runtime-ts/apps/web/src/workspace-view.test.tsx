import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Artifact, RunEvent } from "./api.js";
import { ActivityPanel, RunStatusBadge, RunTimeline } from "./workspace-view.js";

describe("工作台展示组件", () => {
  it("将运行状态转换为面向用户的中文状态", () => {
    const html = renderToStaticMarkup(<RunStatusBadge status="waiting" />);

    expect(html).toContain("等待输入");
    expect(html).toContain("is-waiting");
  });

  it("活动面板只使用事件安全摘要，不渲染原始工具回执", () => {
    const events: readonly RunEvent[] = [
      {
        eventId: "event-1",
        sequence: 1,
        occurredAt: "",
        kind: "agent_event",
        type: "tool.completed",
        payload: { name: "read_file", callId: "call-1", secret: "不应展示" },
      },
    ];
    const artifacts: readonly Artifact[] = [];
    const html = renderToStaticMarkup(
      <ActivityPanel
        isOpen
        events={events}
        artifacts={artifacts}
        onToggle={() => undefined}
        onPreview={() => undefined}
        onDownload={() => undefined}
      />,
    );

    expect(html).toContain("工具 read_file（call-1）完成");
    expect(html).not.toContain("不应展示");
  });

  it("没有事件时显示运行中的明确空态", () => {
    const html = renderToStaticMarkup(<RunTimeline events={[]} />);

    expect(html).toContain("正在等待第一条活动");
  });
});
