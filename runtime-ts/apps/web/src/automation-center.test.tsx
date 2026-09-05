// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduledTask, Thread } from "./api.js";
import { AutomationCenterDialog, type AutomationCenterApi } from "./automation-center.js";

const thread: Thread = {
  id: "thread_1",
  title: "日报任务",
  status: "active",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};
const task: ScheduledTask = {
  id: "automation_1",
  tenantId: "tenant_1",
  ownerUserId: "user_1",
  sourceThreadId: thread.id,
  targetThreadId: thread.id,
  name: "每日摘要",
  instruction: "生成摘要",
  timezone: "Asia/Shanghai",
  rrule: "FREQ=DAILY;INTERVAL=1",
  status: "active",
  overlapPolicy: "coalesce",
  nextRunAt: "2026-08-18T01:00:00.000Z",
  currentRevision: 1,
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

describe("定时任务中心", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("加载任务并支持暂停", async () => {
    const api: AutomationCenterApi = {
      listScheduledTasks: vi.fn(async () => [task]),
      createScheduledTask: vi.fn(async () => task),
      updateScheduledTask: vi.fn(async (_id, input) => ({
        ...task,
        status: input.action === "pause" ? ("paused" as const) : ("active" as const),
      })),
    };
    await act(async () => {
      root.render(
        <AutomationCenterDialog
          api={api}
          threads={[thread]}
          initialThreadId={thread.id}
          onClose={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain("每日摘要");
    const pause = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("暂停"),
    );
    await act(async () => {
      pause?.click();
      await Promise.resolve();
    });
    expect(api.updateScheduledTask).toHaveBeenCalledWith("automation_1", { action: "pause" });
    expect(container.textContent).toContain("已暂停");
  });

  it("同名同时间任务仍可用完整标识区分，选项绑定所选任务", async () => {
    await act(async () =>
      root.render(
        <AutomationCenterDialog
          api={{
            listScheduledTasks: async () => [],
            createScheduledTask: vi.fn(),
            updateScheduledTask: vi.fn(),
          }}
          threads={[thread, { ...thread, id: "thread_2" }]}
          initialThreadId="thread_2"
          onClose={vi.fn()}
        />,
      ),
    );
    const select = container.querySelector<HTMLSelectElement>("select");
    const options = [...(select?.options ?? [])].slice(1);
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("thread_1"),
      expect.stringContaining("thread_2"),
    ]);
    expect(select?.value).toBe("thread_2");
  });

  it("创建时把本地时间转换为 ISO 并绑定目标 Thread", async () => {
    const createScheduledTask = vi.fn(async () => task);
    const api: AutomationCenterApi = {
      listScheduledTasks: vi.fn(async () => []),
      createScheduledTask,
      updateScheduledTask: vi.fn(async () => task),
    };
    await act(async () => {
      root.render(
        <AutomationCenterDialog
          api={api}
          threads={[thread]}
          initialThreadId={thread.id}
          onClose={() => undefined}
        />,
      );
      await Promise.resolve();
    });
    const form = container.querySelector("form");
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(createScheduledTask).toHaveBeenCalledWith(
      expect.objectContaining({
        targetThreadId: "thread_1",
        firstRunAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    );
  });
});
