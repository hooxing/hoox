// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileReferences, type FileReference } from "@hoox/protocol/file-references";
import { developmentSession, persistAccountSession } from "./account-access.js";
import {
  ApiError,
  type Artifact,
  type HistoryFile,
  type Run,
  type TeamSummary,
  type Thread,
} from "./api.js";
import {
  App,
  chooseInitialThread,
  compactThreadTitle,
  deriveThreadTitle,
  nextExpectedUserOccurrence,
  shouldContinueRunPolling,
  shouldFollowLatest,
} from "./main.js";

type AppApi = NonNullable<ComponentProps<typeof App>["apiClient"]>;

const thread = (id: string, status: Thread["status"] = "active"): Thread => ({
  id,
  title: `会话 ${id}`,
  status,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const run = (id: string, threadId: string): Run => ({
  id,
  threadId,
  status: "succeeded",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const textArtifact = (): Artifact => ({
  id: "artifact_text",
  name: "report.txt",
  mediaType: "text/plain; charset=utf-8",
  sizeBytes: 41,
  status: "published",
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

function apiFixture(overrides: Partial<AppApi> = {}): AppApi {
  const defaultThread = thread("thread_default");
  const defaultRun = run("run_default", defaultThread.id);
  return {
    listThreads: vi.fn(async () => []),
    listLatestRuns: vi.fn(async () => []),
    getRun: vi.fn(async () => defaultRun),
    listEvents: vi.fn(async () => ({ attemptId: undefined, items: [] })),
    listArtifacts: vi.fn(async () => []),
    createThread: vi.fn(async () => defaultThread),
    archiveThread: vi.fn(async () => defaultThread),
    createRun: vi.fn(async () => defaultRun),
    cancelRun: vi.fn(async () => defaultRun),
    downloadArtifact: vi.fn(async () => "https://example.invalid/download"),
    previewArtifact: vi.fn(async () => ({
      kind: "url" as const,
      url: "https://example.invalid/preview",
    })),
    uploadResource: vi.fn(async (file: File) => ({
      resourceId: "resource_uploaded",
      versionId: "resource_version_uploaded",
      name: file.name,
      path: `/resources/resource_uploaded/resource_version_uploaded/${file.name}`,
      mediaType: file.type || "application/octet-stream",
      sizeBytes: file.size,
    })),
    ...overrides,
  };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const mountedRoots: Root[] = [];

function mount(apiClient: AppApi): { readonly container: HTMLDivElement; readonly root: Root } {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => root.render(<App apiClient={apiClient} />));
  return { container, root };
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await act(async () => Promise.resolve());
  }
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  persistAccountSession(window.localStorage, developmentSession);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: "(max-width: 820px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("Agent 工作台恢复接入", () => {
  it("恢复选区草稿，空文字也可发送；引用保持旧版本并在成功后清除", async () => {
    const active = thread("reference_thread");
    const reference: FileReference = {
      source: {
        threadId: active.id,
        runId: "old_run",
        artifactId: "old_artifact",
        versionId: "old_version",
        name: "报告.docx",
      },
      selection: { kind: "text", quote: "待修改内容", start: 0, end: 5 },
    };
    const storageKey = `hoox.conversation-draft.v1:${encodeURIComponent(developmentSession.profile.id)}:references:${JSON.stringify([null, active.id])}`;
    sessionStorage.setItem(storageKey, JSON.stringify([{ id: "draft_reference", reference }]));
    const queuedRun = run("new_run", active.id);
    const submitThreadInput = vi.fn(async () => ({
      receiptId: "reference_receipt",
      inputSequence: 1,
      requestedMode: "auto" as const,
      disposition: "queued" as const,
      queuedRun,
      createdAt: queuedRun.createdAt,
      updatedAt: queuedRun.updatedAt,
    }));
    const { container } = mount(
      apiFixture({ listThreads: async () => [active], submitThreadInput }),
    );
    await settleEffects();
    expect(container.querySelector('[aria-label="待发送引用"]')?.textContent).toContain(
      "报告.docx",
    );
    const sendButton = container.querySelector<HTMLButtonElement>('[aria-label="发送任务"]');
    expect(sendButton?.disabled).toBe(false);
    await act(async () => sendButton?.click());
    await settleEffects();
    expect(submitThreadInput).toHaveBeenCalledWith(
      active.id,
      "请处理本轮提供的文件。",
      "auto",
      undefined,
      [],
      [reference],
    );
    expect(sessionStorage.getItem(storageKey)).toBeNull();
    expect(container.querySelector('[aria-label="引用的文件区域"]')?.textContent).toContain(
      "报告.docx",
    );
  });

  it("历史引用从原 Run 和不可变版本重新读取，切换会话立即关闭预览", async () => {
    const active = thread("reference_history");
    const reference: FileReference = {
      source: {
        threadId: active.id,
        runId: "old_run",
        artifactId: "old_artifact",
        versionId: "old_version",
        name: "报告.docx",
      },
      selection: { kind: "page", page: 2 },
    };
    const readArtifactContent = vi.fn(async () => new Promise<ArrayBuffer>(() => {}));
    const { container } = mount(
      apiFixture({
        listThreads: async () => [active],
        listThreadContext: async () => [
          {
            role: "user",
            sequence: 1,
            text: appendFileReferences("修改这页", [reference]),
            createdAt: active.createdAt,
          },
        ],
        readArtifactContent,
      }),
    );
    await settleEffects();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="引用的文件区域"] button')?.click(),
    );
    expect(readArtifactContent).toHaveBeenCalledWith(reference.source, expect.any(AbortSignal));
    expect(container.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin");
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="关闭文件预览"]')?.click(),
    );
    expect(container.querySelector(".file-preview-panel")).toBeNull();
  });

  it("重新挂载工作台恢复当前会话文字草稿，成功发送后不再恢复", async () => {
    const selected = thread("draft_restore");
    const apiClient = apiFixture({ listThreads: async () => [selected] });
    const first = mount(apiClient);
    await settleEffects();
    const input = first.container.querySelector("textarea");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        input,
        "刷新保留",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => first.root.render(null));
    const restored = mount(apiClient);
    await settleEffects();
    expect(restored.container.querySelector("textarea")?.value).toBe("刷新保留");
    await act(async () =>
      restored.container
        .querySelector("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settleEffects();
    act(() => restored.root.render(null));
    const sent = mount(apiClient);
    await settleEffects();
    expect(sent.container.querySelector("textarea")?.value).toBe("");
  });

  it.each(["failed", "rejected"] as const)(
    "新会话已创建但提交 %s 时，刷新仍恢复待重试内容",
    async (outcome) => {
      let created = false;
      const selected = thread("draft_failed");
      const apiClient = apiFixture({
        listThreads: async () => (created ? [selected] : []),
        createThread: async () => {
          created = true;
          return selected;
        },
        createRun: async () => {
          throw new ApiError("提交失败", 503, true);
        },
        ...(outcome === "rejected"
          ? {
              submitThreadInput: async () => ({
                receiptId: "rejected_draft",
                inputSequence: 1,
                requestedMode: "auto" as const,
                disposition: "rejected" as const,
                rejectionCode: "RUN_NOT_RUNNING",
                createdAt: selected.createdAt,
                updatedAt: selected.updatedAt,
              }),
            }
          : {}),
      });
      const first = mount(apiClient);
      await settleEffects();
      const input = first.container.querySelector("textarea");
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
          input,
          "失败重试草稿",
        );
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () =>
        first.container
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settleEffects();
      expect(first.container.querySelector("textarea")?.value).toBe("失败重试草稿");
      act(() => first.root.render(null));
      const restored = mount(apiClient);
      await settleEffects();
      expect(restored.container.querySelector("textarea")?.value).toBe("失败重试草稿");
    },
  );

  it("内容异步增高时跟随底部，重复通知和用户回看不重写滚动位置", async () => {
    let resized: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const active = run("run_scroll", "thread_scroll");
      const { container } = mount(
        apiFixture({
          listThreads: vi.fn(async () => [thread(active.threadId)]),
          listLatestRuns: vi.fn(async () => [active]),
          getRun: vi.fn(async () => active),
        }),
      );
      await settleEffects();
      const area = container.querySelector<HTMLElement>(".run-area");
      if (area === null) throw new Error("缺少滚动区域");
      let height = 400;
      let top = 0;
      const writeTop = vi.fn((value: number) => {
        top = value;
      });
      Object.defineProperties(area, {
        scrollHeight: { get: () => height },
        clientHeight: { get: () => 100 },
        scrollTop: { get: () => top, set: writeTop },
      });
      act(() => resized?.());
      expect(top).toBe(300);
      act(() => resized?.());
      expect(writeTop).toHaveBeenCalledOnce();
      top = 40;
      act(() => area.dispatchEvent(new Event("scroll", { bubbles: true })));
      height = 600;
      act(() => resized?.());
      expect(top).toBe(40);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("正文不等待辅助接口，完整排空前不跳到下一 Run，切走后取消连接", async () => {
    const active = { ...run("run_stream", "thread_stream"), status: "running" as const };
    const artifacts = deferred<Artifact[]>();
    let connectionSignal: AbortSignal | undefined;
    const api = apiFixture({
      listThreads: vi.fn(async () => [thread(active.threadId)]),
      listLatestRuns: vi.fn(async () => [active]),
      getRun: vi.fn(async () => ({ ...active, status: "succeeded" as const })),
      listArtifacts: vi.fn(() => artifacts.promise),
      streamEvents: vi.fn(async (_thread, _run, _cursor, signal, receive) => {
        connectionSignal = signal;
        receive(
          {
            attemptId: "attempt_stream",
            hasMore: false,
            items: [
              {
                eventId: "attempt_stream-0",
                sequence: 0,
                kind: "agent_event",
                type: "message.delta",
                payload: { delta: "不等待附件的文字" },
                occurredAt: active.createdAt,
              },
            ],
          },
          active,
        );
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        return "settled" as const;
      }),
    });
    const { container, root } = mount(api);
    await settleEffects();
    expect(container.textContent).toContain("不等待附件的文字");
    expect(api.listEvents).not.toHaveBeenCalled();
    artifacts.resolve([]);
    await settleEffects();
    expect(api.listLatestRuns).toHaveBeenCalledOnce();
    act(() => root.render(<div />));
    expect(connectionSignal?.aborted).toBe(true);
    await settleEffects();
  });
  it("没有会话时使用透明横版品牌图作为欢迎标识", async () => {
    const { container } = mount(apiFixture());

    await settleEffects();

    expect(
      container
        .querySelector<HTMLImageElement>(".empty.primary .welcome-logo")
        ?.getAttribute("src"),
    ).toBe("/brand/hoox-horizontal-transparent.png");
    expect(container.querySelector(".empty.primary")?.textContent).not.toContain("✦");
  });

  it("技能中心与云盘作为侧栏独立入口显示在任务列表上方", async () => {
    const { container } = mount(
      apiFixture({
        listSkills: vi.fn(async () => ({ items: [] })),
        listInstalledSkills: vi.fn(async () => []),
        installSkill: vi.fn(async () => {
          throw new Error("不应安装技能");
        }),
        setSkillEnabled: vi.fn(async () => {
          throw new Error("不应更新技能");
        }),
        uninstallSkill: vi.fn(async () => {
          throw new Error("不应卸载技能");
        }),
        listScheduledTasks: vi.fn(async () => []),
        createScheduledTask: vi.fn(async () => {
          throw new Error("不应创建定时任务");
        }),
        updateScheduledTask: vi.fn(async () => {
          throw new Error("不应更新定时任务");
        }),
        listHistoryFiles: vi.fn(async () => ({
          items: [],
          range: { activeAfter: "2026-02-07T00:00:00.000Z" },
          hasMore: false,
          hasOlder: false,
        })),
        downloadHistoryFile: vi.fn(async () => "http://127.0.0.1/history-download"),
      }),
    );

    await settleEffects();

    const createEntry = container.querySelector(".thread-create");
    const skillCenterEntry = container.querySelector(".skill-center-entry");
    const automationEntry = container.querySelector(".automation-entry");
    const cloudDriveEntry = container.querySelector(".cloud-drive-entry");
    const taskHeading = container.querySelector(".thread-heading");
    expect(createEntry).not.toBeNull();
    expect(skillCenterEntry).not.toBeNull();
    expect(automationEntry).not.toBeNull();
    expect(cloudDriveEntry).not.toBeNull();
    expect(createEntry?.nextElementSibling).toBe(skillCenterEntry);
    expect(skillCenterEntry?.nextElementSibling).toBe(automationEntry);
    expect(automationEntry?.nextElementSibling).toBe(cloudDriveEntry);
    expect(cloudDriveEntry?.nextElementSibling).toBe(taskHeading);
  });

  it("发布到团队通过下拉选择目标，取消不创建分支", async () => {
    const personalThread = thread("personal_task");
    const forkThread = vi.fn(async () => thread("published_task"));
    const { container } = mount(
      apiFixture({
        listThreads: async () => [personalThread],
        forkThread,
        listTeams: async () =>
          ["one", "two"].map((id) => ({
            id,
            displayName: "同名团队",
            role: "owner" as const,
            joinedAt: "2026-08-09T08:00:00.000Z",
          })),
        createTeam: vi.fn(),
        listTeamMembers: async () => [],
        addTeamMember: vi.fn(),
        changeTeamMemberRole: vi.fn(),
        removeTeamMember: vi.fn(),
        dissolveTeam: vi.fn(),
      }),
    );
    await settleEffects();
    const publish = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) => button.textContent === "发布到团队",
    );
    expect(publish).toBeDefined();
    await act(async () => publish?.click());
    expect(forkThread).not.toHaveBeenCalled();
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".action-dialog [data-cancel]")?.click(),
    );
    expect(forkThread).not.toHaveBeenCalled();
    await act(async () => publish?.click());
    const select = document.querySelector<HTMLSelectElement>(".action-dialog select");
    expect(select?.options).toHaveLength(2);
    await act(async () => {
      if (select) {
        select.value = "two";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.action-dialog button[type="submit"]')?.click(),
    );
    expect(forkThread).toHaveBeenCalledExactlyOnceWith("personal_task", "two");
  });

  it("没有已加入团队时不显示发布到团队入口", async () => {
    const personalThread = thread("personal_task");
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [personalThread]),
      forkThread: vi.fn(async () => thread("published_task")),
      listTeams: vi.fn(async () => []),
      createTeam: vi.fn(async () => {
        throw new Error("本测试不创建团队");
      }),
      listTeamMembers: vi.fn(async () => []),
      addTeamMember: vi.fn(async () => {
        throw new Error("本测试不添加成员");
      }),
      changeTeamMemberRole: vi.fn(async () => {
        throw new Error("本测试不修改角色");
      }),
      removeTeamMember: vi.fn(async () => undefined),
      dissolveTeam: vi.fn(async () => undefined),
    });
    const { container } = mount(apiClient);

    await settleEffects();

    expect(container.querySelector(".conversation-header")?.textContent).not.toContain(
      "发布到团队",
    );
  });

  it("个人任务永久保留，团队切换只改变团队任务栏，新建会话始终回到个人空间", async () => {
    const personalThread = thread("personal_task");
    const teamThread = thread("team_task");
    const teamSummary = {
      id: "tenant_product",
      displayName: "产品团队",
      role: "owner" as const,
      joinedAt: "2026-08-09T08:00:00.000Z",
    };
    const setTenantId = vi.fn();
    const apiClient = apiFixture({
      listThreadsForTenant: vi.fn(async (teamId?: string) =>
        teamId === teamSummary.id ? [teamThread] : [personalThread],
      ),
      setTenantId,
      listTeams: vi.fn(async () => [teamSummary]),
      createTeam: vi.fn(async () => teamSummary),
      listTeamMembers: vi.fn(async () => []),
      addTeamMember: vi.fn(async () => {
        throw new Error("本测试不添加成员");
      }),
      changeTeamMemberRole: vi.fn(async () => {
        throw new Error("本测试不修改角色");
      }),
      removeTeamMember: vi.fn(async () => undefined),
      dissolveTeam: vi.fn(async () => undefined),
    });
    const { container } = mount(apiClient);
    await settleEffects();

    const personalNavigation = container.querySelector<HTMLElement>(
      'nav[aria-label="个人任务列表"]',
    );
    expect(personalNavigation?.textContent).toContain("会话 personal_task");

    const teamSummaryButton = container.querySelector<HTMLButtonElement>(".team-switcher-summary");
    await act(async () => teamSummaryButton?.click());
    await settleEffects();
    const teamNavigation = container.querySelector<HTMLElement>('nav[aria-label="团队任务列表"]');
    expect(teamNavigation?.textContent).toContain("会话 team_task");
    expect(container.querySelectorAll(".thread-heading")[0]?.textContent).toContain("个人任务");

    const teamTaskButton = teamNavigation?.querySelector<HTMLButtonElement>(".thread");
    await act(async () => teamTaskButton?.click());
    expect(setTenantId).toHaveBeenLastCalledWith(teamSummary.id);
    expect(personalNavigation?.textContent).toContain("会话 personal_task");

    const newConversation = container.querySelector<HTMLButtonElement>(".new-thread-button");
    await act(async () => newConversation?.click());
    expect(setTenantId).toHaveBeenLastCalledWith(undefined);
  });

  it("个人任务可以在侧栏改名和删除，归档任务不会重新出现在列表", async () => {
    const personalThread = thread("personal_manage");
    const archivedThread = thread("personal_archived", "archived");
    const renamePersonalThreadForTenant = vi.fn(
      async (_threadId: string, title: string, _teamId?: string) => ({
        ...personalThread,
        title,
        updatedAt: "2026-08-28T01:00:00.000Z",
      }),
    );
    const archiveThreadForTenant = vi.fn(async () => ({
      ...personalThread,
      status: "archived" as const,
    }));
    const { container } = mount(
      apiFixture({
        listThreadsForTenant: vi.fn(async () => [personalThread, archivedThread]),
        renamePersonalThreadForTenant,
        archiveThreadForTenant,
      }),
    );
    await settleEffects();

    const navigation = container.querySelector<HTMLElement>('nav[aria-label="个人任务列表"]');
    expect(navigation?.querySelector('button[aria-label="会话 personal_manage"]')).not.toBeNull();
    expect(navigation?.querySelector('button[aria-label="会话 personal_archived"]')).toBeNull();

    const renameButton = navigation?.querySelector<HTMLButtonElement>(
      'button[aria-label^="重命名个人任务"]',
    );
    await act(async () => renameButton?.click());
    expect(renamePersonalThreadForTenant).not.toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>(".action-dialog input");
    expect(input?.value).toBe(personalThread.title);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        input,
        "新的个人任务名称",
      );
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.action-dialog button[type="submit"]')?.click(),
    );
    await settleEffects();
    expect(renamePersonalThreadForTenant).toHaveBeenCalledWith(
      personalThread.id,
      "新的个人任务名称",
      undefined,
    );
    expect(navigation?.querySelector('button[aria-label="新的个人任务名称"]')).not.toBeNull();

    const deleteButton = navigation?.querySelector<HTMLButtonElement>(
      'button[aria-label^="删除个人任务"]',
    );
    await act(async () => deleteButton?.click());
    await settleEffects();
    expect(archiveThreadForTenant).not.toHaveBeenCalled();
    expect(document.querySelector(".action-dialog")?.textContent).toContain(
      "删除“新的个人任务名称”？任务将从个人任务列表移除。",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".action-dialog [data-cancel]")?.click(),
    );
    expect(archiveThreadForTenant).not.toHaveBeenCalled();
    await act(async () => deleteButton?.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.action-dialog button[type="submit"]')?.click(),
    );
    await settleEffects();
    expect(archiveThreadForTenant).toHaveBeenCalledWith(personalThread.id, undefined);
    expect(navigation?.querySelector('button[aria-label="新的个人任务名称"]')).toBeNull();
  });

  it("移动会话导航展开时隐藏打开按钮并保留关闭入口", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        media: "(max-width: 820px)",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    const { container } = mount(apiFixture());
    await settleEffects();

    const open = container.querySelector<HTMLButtonElement>('button[aria-label="打开会话导航"]');
    expect(open).not.toBeNull();
    await act(async () => open?.click());

    expect(open?.hidden).toBe(true);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="关闭会话导航"]');
    expect(close).not.toBeNull();
    await act(async () => close?.click());

    expect(open?.hidden).toBe(false);
    expect(document.activeElement).toBe(open);
  });

  it("重复点击团队新增对话不会清空已加载的团队任务", async () => {
    const teamSummary: TeamSummary = {
      id: "tenant_product",
      displayName: "产品团队",
      role: "owner",
      joinedAt: "2026-08-09T08:00:00.000Z",
    };
    const teamThread = thread("team_task");
    const apiClient = apiFixture({
      listThreadsForTenant: vi.fn(async (teamId?: string) =>
        teamId === teamSummary.id ? [teamThread] : [],
      ),
      setTenantId: vi.fn(),
      listTeams: vi.fn(async () => [teamSummary]),
      createTeam: vi.fn(async () => teamSummary),
      listTeamMembers: vi.fn(async () => []),
      addTeamMember: vi.fn(async () => {
        throw new Error("本测试不添加成员");
      }),
      changeTeamMemberRole: vi.fn(async () => {
        throw new Error("本测试不修改角色");
      }),
      removeTeamMember: vi.fn(async () => undefined),
      dissolveTeam: vi.fn(async () => undefined),
    });
    const { container } = mount(apiClient);
    await settleEffects();

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-switcher-summary")?.click(),
    );
    await settleEffects();
    const teamNavigation = container.querySelector<HTMLElement>('nav[aria-label="团队任务列表"]');
    expect(teamNavigation?.textContent).toContain("会话 team_task");

    const create = container.querySelector<HTMLButtonElement>(".team-new-thread-shortcut");
    await act(async () => create?.click());
    await settleEffects();
    await act(async () => create?.click());
    await settleEffects();

    expect(teamNavigation?.textContent).toContain("会话 team_task");
  });

  it("团队目录刷新会清除已经退出或解散的活动 Tenant", async () => {
    const oldTeam = {
      id: "tenant_removed",
      displayName: "旧团队",
      role: "owner" as const,
      joinedAt: "2026-08-09T08:00:00.000Z",
    };
    const replacementTeam = {
      id: "tenant_replacement",
      displayName: "新团队",
      role: "member" as const,
      joinedAt: "2026-08-10T08:00:00.000Z",
    };
    let directory: readonly TeamSummary[] = [oldTeam];
    const setTenantId = vi.fn();
    const apiClient = apiFixture({
      listThreadsForTenant: vi.fn(async (teamId?: string) =>
        teamId === oldTeam.id ? [thread("old_team_task")] : [],
      ),
      setTenantId,
      listTeams: vi.fn(async () => directory),
      createTeam: vi.fn(async () => replacementTeam),
      listTeamMembers: vi.fn(async () => []),
      addTeamMember: vi.fn(async () => {
        throw new Error("本测试不添加成员");
      }),
      changeTeamMemberRole: vi.fn(async () => {
        throw new Error("本测试不修改角色");
      }),
      removeTeamMember: vi.fn(async () => undefined),
      dissolveTeam: vi.fn(async () => undefined),
    });
    const { container } = mount(apiClient);
    await settleEffects();

    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-switcher-summary")?.click(),
    );
    await settleEffects();
    await act(async () =>
      container
        .querySelector<HTMLElement>('nav[aria-label="团队任务列表"]')
        ?.querySelector<HTMLButtonElement>(".thread")
        ?.click(),
    );
    expect(setTenantId).toHaveBeenLastCalledWith(oldTeam.id);

    directory = [replacementTeam];
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".account-menu-trigger")?.click(),
    );
    await act(async () => {
      const teamCenterEntry = Array.from(
        container.querySelectorAll<HTMLButtonElement>(".account-menu-section button"),
      ).find((button) => button.textContent?.includes("团队中心"));
      teamCenterEntry?.click();
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".team-center-refresh")?.click(),
    );
    await settleEffects();

    expect(setTenantId).toHaveBeenLastCalledWith(undefined);
    expect(
      container.querySelector<HTMLSelectElement>(".team-switcher-controls select")?.value,
    ).toBe(replacementTeam.id);
  });

  it("重复文本只计算尚未落入 Thread 上下文的消息，拒绝项不占用序号", () => {
    expect(
      nextExpectedUserOccurrence(
        [{ role: "user", text: "继续" }],
        [
          {
            text: "继续",
            disposition: "queued",
            expectedUserOccurrence: 1,
          },
          {
            text: "继续",
            disposition: "rejected",
            expectedUserOccurrence: 2,
          },
        ],
        "继续",
      ),
    ).toBe(2);
    expect(
      nextExpectedUserOccurrence(
        [{ role: "user", text: "继续" }],
        [
          {
            text: "继续",
            disposition: "queued",
            expectedUserOccurrence: 2,
          },
        ],
        "继续",
      ),
    ).toBe(3);
  });

  it("从首条有效请求生成确定性、紧凑的会话标题", () => {
    expect(deriveThreadTitle("  # 调研\nOpenAI *最新* 模型，并给出建议  ")).toBe(
      "调研 OpenAI 最新 模型，并给…",
    );
    expect(deriveThreadTitle("甲".repeat(40))).toBe(`${"甲".repeat(18)}…`);
    expect(deriveThreadTitle(" \n ")).toBe("新任务");
    expect(compactThreadTitle("帮我起草一份投诉信，要求电信退款的，docx")).toBe(
      "帮我起草一份投诉信，要求电信退款…",
    );
  });

  it("waiting 不启动无限短轮询，但未读事件页仍会被排空", () => {
    expect(shouldContinueRunPolling(false, "waiting")).toBe(false);
    expect(shouldContinueRunPolling(true, "waiting")).toBe(true);
    expect(shouldContinueRunPolling(false, "running")).toBe(true);
    expect(shouldContinueRunPolling(true, "running", "resuming", "recovery_required")).toBe(false);
  });

  it("recovery_required 首次读取投影后停止所有短轮询来源", async () => {
    vi.useFakeTimers();
    const selectedThread = thread("thread_recovery_required");
    const interruptedRun: Run = {
      ...run("run_recovery_required", selectedThread.id),
      status: "running",
      executionStatus: "recovery_required",
    };
    const getRun = vi.fn(async () => interruptedRun);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(async () => [interruptedRun]),
      getRun,
    });
    const { container } = mount(apiClient);
    await settleEffects();

    expect(getRun).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("执行已中断");
    await act(async () => vi.advanceTimersByTimeAsync(12_000));
    await settleEffects();
    expect(getRun).toHaveBeenCalledTimes(1);
  });

  it("停留在终态任务页面时自动发现定时任务创建的新 Run", async () => {
    vi.useFakeTimers();
    const selectedThread = thread("thread_automation_refresh");
    const initialRun = run("run_initial", selectedThread.id);
    const scheduledRun = { ...run("run_scheduled", selectedThread.id), status: "running" as const };
    let latestRun = initialRun;
    const listLatestRuns = vi.fn(async () => [latestRun]);
    const getRun = vi.fn(async (_threadId: string, runId: string) =>
      runId === scheduledRun.id ? scheduledRun : initialRun,
    );
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns,
      getRun,
      listThreadContext: vi.fn(async () => []),
    });
    mount(apiClient);
    await settleEffects();

    latestRun = scheduledRun;
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    await settleEffects();

    expect(getRun).toHaveBeenCalledWith(selectedThread.id, scheduledRun.id);
  });

  it("Run 终态后继续追踪 Sandbox 瞬时态，稳定或 UNKNOWN 后停止短轮询", () => {
    expect(shouldContinueRunPolling(false, "succeeded", "pausing")).toBe(true);
    expect(shouldContinueRunPolling(false, "succeeded", "resuming")).toBe(true);
    expect(shouldContinueRunPolling(false, "succeeded", "paused")).toBe(false);
    expect(shouldContinueRunPolling(false, "succeeded", "unknown")).toBe(false);
  });

  it("只在用户仍停留于底部附近时自动跟随最新进展", () => {
    expect(shouldFollowLatest(1_000, 500, 400)).toBe(false);
    expect(shouldFollowLatest(1_000, 510, 400)).toBe(true);
    expect(shouldFollowLatest(1_000, 600, 400)).toBe(true);
  });

  it("首条请求自动创建会话并使用派生标题，用户无需预先填写标题", async () => {
    const createdThread = thread("thread_created");
    const createdRun = run("run_created", createdThread.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => []),
      createThread: vi.fn(async () => createdThread),
      createRun: vi.fn(async () => createdRun),
      getRun: vi.fn(async () => createdRun),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form");
    if (textarea === null || form === null) throw new Error("未渲染任务输入区");
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "  生成一份周报  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settleEffects();

    expect(apiClient.createThread).toHaveBeenCalledWith("生成一份周报", "agent_default");
    expect(apiClient.createThread).toHaveBeenCalledTimes(1);
    expect(apiClient.createRun).toHaveBeenCalledWith(createdThread.id, "生成一份周报");
    expect(container.querySelector("h1")?.textContent).toBe(createdThread.title);
  });

  it("新建任务可选 Agent，欢迎问题填入后按所选 Agent 创建 Thread", async () => {
    const createdThread = thread("thread_sales");
    const createdRun = run("run_sales", createdThread.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => []),
      listAvailableAgents: vi.fn(async () => [
        {
          id: "agent_default",
          displayName: "默认助手",
          description: "默认",
          suggestedQuestions: [],
        },
        {
          id: "agent_sales",
          displayName: "销售助手",
          description: "销售",
          welcomeMessage: "想整理哪类线索？",
          suggestedQuestions: ["整理本周线索"],
        },
      ]),
      createThread: vi.fn(async () => createdThread),
      createRun: vi.fn(async () => createdRun),
      getRun: vi.fn(async () => createdRun),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    const selector = container.querySelector<HTMLSelectElement>('select[aria-label="选择 Agent"]');
    if (selector === null) throw new Error("Agent 选择器未显示");
    act(() => {
      selector.value = "agent_sales";
      selector.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const suggestion = container.querySelector(".suggested-question");
    if (!(suggestion instanceof HTMLButtonElement)) throw new Error("建议问题未显示");
    act(() => suggestion.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    const form = container.querySelector("form");
    if (form === null) throw new Error("任务输入区未显示");
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settleEffects();
    expect(apiClient.createThread).toHaveBeenCalledWith("整理本周线索", "agent_sales");
  });

  it("上传图片发送后保留在用户消息中并加载 inline 预览", async () => {
    const active = thread("thread_image_upload");
    const image = new File([new Uint8Array([1, 2, 3])], "向日葵.png", { type: "image/png" });
    const uploaded = {
      resourceId: "resource_sunflower",
      versionId: "version_sunflower",
      name: image.name,
      path: "/resources/resource_sunflower/version_sunflower/向日葵.png",
      mediaType: image.type,
      sizeBytes: image.size,
    };
    const submitThreadInput = vi.fn(async () => ({
      receiptId: "input_image",
      inputSequence: 1,
      requestedMode: "auto" as const,
      disposition: "queued" as const,
      createdAt: "2026-08-25T01:00:00.000Z",
      updatedAt: "2026-08-25T01:00:00.000Z",
    }));
    const previewHistoryFile = vi.fn(async () => "https://example.test/sunflower-preview");
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [active]),
      listLatestRuns: vi.fn(async () => []),
      uploadResource: vi.fn(async () => uploaded),
      submitThreadInput,
      previewHistoryFile,
    });
    const { container } = mount(apiClient);
    await settleEffects();

    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (fileInput === null || textarea === null) throw new Error("未渲染附件输入区");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [image] });
    act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "这是啥东西");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () =>
      textarea
        .closest("form")
        ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settleEffects();

    expect(apiClient.uploadResource).toHaveBeenCalledWith(image, expect.any(String));
    expect(submitThreadInput).toHaveBeenCalledWith(active.id, "这是啥东西", "auto", undefined, [
      uploaded,
    ]);
    expect(previewHistoryFile).toHaveBeenCalledWith(uploaded);
    expect(container.querySelector<HTMLImageElement>(".user-request-attachment img")?.src).toBe(
      "https://example.test/sunflower-preview",
    );
    expect(container.querySelector(".composer-file")).toBeNull();

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "继续输入下一条消息");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settleEffects();

    expect(previewHistoryFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLImageElement>(".user-request-attachment img")?.src).toBe(
      "https://example.test/sunflower-preview",
    );
  });

  it("通过 @ 选择历史文件后使用统一结构化附件提交，且不重新上传", async () => {
    vi.useFakeTimers();
    const active = thread("thread_history_target");
    const historyFile: HistoryFile = {
      threadId: "thread_history_source",
      taskName: "采购合同审查",
      resourceId: "resource_contract",
      versionId: "version_contract",
      name: "采购合同.docx",
      entryName: "采购合同.docx",
      path: "/resources/resource_contract/version_contract/采购合同.docx",
      mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      attachedAt: "2026-08-07T08:00:00.000Z",
    };
    const submitThreadInput = vi.fn(async () => ({
      receiptId: "input_history",
      inputSequence: 1,
      requestedMode: "auto" as const,
      disposition: "queued" as const,
      createdAt: "2026-08-07T08:01:00.000Z",
      updatedAt: "2026-08-07T08:01:00.000Z",
    }));
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [active]),
      listLatestRuns: vi.fn(async () => []),
      listHistoryFiles: vi.fn(async () => ({
        items: [
          {
            threadId: historyFile.threadId,
            name: historyFile.taskName,
            createdAt: "2026-08-07T07:00:00.000Z",
            lastFileAt: historyFile.attachedAt,
            fileCount: 1,
            files: [historyFile],
          },
        ],
        range: { activeAfter: "2026-02-07T00:00:00.000Z" },
        hasMore: false,
        hasOlder: false,
      })),
      submitThreadInput,
    });
    const { container } = mount(apiClient);
    await settleEffects();

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea");
    if (textarea === null) throw new Error("未渲染任务输入区");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "@采购");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      vi.advanceTimersByTime(180);
      await Promise.resolve();
      await Promise.resolve();
    });
    const option = container.querySelector<HTMLButtonElement>('[role="option"]');
    expect(option?.textContent).toContain("采购合同.docx");
    act(() => option?.click());
    expect(container.querySelector(".composer-file.is-history")?.textContent).toBe("采购合同.docx");

    const form = textarea.closest("form");
    await act(async () =>
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settleEffects();
    expect(submitThreadInput).toHaveBeenCalledWith(
      active.id,
      "请处理本轮提供的文件。",
      "auto",
      undefined,
      [historyFile],
    );
    expect(apiClient.uploadResource).not.toHaveBeenCalled();
    expect(container.querySelector(".composer-file.is-history")).toBeNull();
    expect(container.querySelector(".user-request-attachment-meta")?.textContent).toContain(
      "采购合同.docx",
    );
  });

  it("刷新后恢复最新 Run，并只读取工作台可见的事件与产物投影", async () => {
    const archived = thread("thread_archived", "archived");
    const active = thread("thread_active");
    const latest = run("run_latest", active.id);
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [archived, active]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
    });
    const { container } = mount(apiClient);

    await settleEffects();

    expect(apiClient.listLatestRuns).toHaveBeenCalledWith(active.id, 1);
    expect(apiClient.getRun).toHaveBeenCalledWith(active.id, latest.id);
    expect(container.querySelector("h1")?.textContent).toBe(active.title);
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_latest",
    );
    expect(apiClient.listEvents).toHaveBeenCalledWith(active.id, latest.id, -1, 100);
    expect(apiClient.listArtifacts).toHaveBeenCalledWith(active.id, latest.id);
  });

  it("切换和切回都会重新恢复，迟到错误与加载不会污染其他 Thread", async () => {
    const first = thread("thread_1");
    const second = thread("thread_2");
    const recoveries: Array<{
      readonly threadId: string;
      readonly request: Deferred<readonly Run[]>;
    }> = [];
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [first, second]),
      listLatestRuns: vi.fn((threadId: string) => {
        const request = deferred<readonly Run[]>();
        recoveries.push({ threadId, request });
        return request.promise;
      }),
    });
    const { container } = mount(apiClient);

    await settleEffects();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]?.threadId).toBe(first.id);

    const secondButton = [...container.querySelectorAll<HTMLButtonElement>(".thread")].find(
      (button) => button.textContent?.includes(second.title),
    );
    if (secondButton === undefined) throw new Error("未找到第二个会话按钮");
    act(() => secondButton.click());
    await settleEffects();
    expect(recoveries).toHaveLength(2);
    expect(container.textContent).toContain("正在恢复最新运行");

    await act(async () => recoveries[0]?.request.reject(new ApiError("旧恢复失败", 503, true)));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe(second.title);

    await act(async () => recoveries[1]?.request.resolve([]));
    expect(container.textContent).toContain("就绪");
    expect(container.textContent).toContain("从一个明确的目标开始");

    const firstButton = [...container.querySelectorAll<HTMLButtonElement>(".thread")].find(
      (button) => button.textContent?.includes(first.title),
    );
    if (firstButton === undefined) throw new Error("未找到第一个会话按钮");
    act(() => firstButton.click());
    await settleEffects();
    expect(recoveries).toHaveLength(3);
    expect(recoveries[2]?.threadId).toBe(first.id);
    await act(async () => recoveries[2]?.request.resolve([]));
    expect(container.querySelector("h1")?.textContent).toBe(first.title);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("同 Thread 新建 Run 后使在途恢复失效，迟到空结果不能覆盖新 Run", async () => {
    const selectedThread = thread("thread_1");
    const newRun = run("run_new", selectedThread.id);
    const pendingRecovery = deferred<readonly Run[]>();
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(() => pendingRecovery.promise),
      createRun: vi.fn(async () => newRun),
      getRun: vi.fn(async () => newRun),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    expect(apiClient.listLatestRuns).toHaveBeenCalledWith(selectedThread.id, 1);

    const textarea = container.querySelector("textarea");
    const form = container.querySelector("form");
    if (textarea === null || form === null) throw new Error("未渲染会话输入区");
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )?.set;
      valueSetter?.call(textarea, "启动新的分析");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    await settleEffects();
    expect(apiClient.createRun).toHaveBeenCalledWith(selectedThread.id, "启动新的分析");
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_new",
    );

    await act(async () => pendingRecovery.resolve([]));
    await settleEffects();
    expect(container.querySelector(".conversation-header")?.getAttribute("data-run-id")).toBe(
      "run_new",
    );
    expect(apiClient.getRun).toHaveBeenCalledWith(selectedThread.id, newRun.id);
  });

  it("恶意 HTML 文本只渲染为 pre 的文本节点，且不打开或导航弹窗", async () => {
    const selectedThread = thread("thread_text");
    const latest = run("run_text", selectedThread.id);
    const payload = "<script>window.pwned=true</script>";
    const open = vi.spyOn(window, "open");
    const apiClient = apiFixture({
      listThreads: vi.fn(async () => [selectedThread]),
      listLatestRuns: vi.fn(async () => [latest]),
      getRun: vi.fn(async () => latest),
      listArtifacts: vi.fn(async () => [textArtifact()]),
      previewArtifact: vi.fn(async () => ({ kind: "text" as const, text: payload })),
    });
    const { container } = mount(apiClient);
    await settleEffects();
    const preview = container.querySelector<HTMLButtonElement>("[aria-label='预览 report.txt']");
    if (preview === null) throw new Error("未渲染纯文本预览按钮");
    await act(async () => preview.click());

    const rendered = container.querySelector(".artifact-text-preview pre");
    expect(rendered?.textContent).toBe(payload);
    expect(rendered?.querySelector("script")).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("初始选择策略跳过归档 Thread，并在无活跃 Thread 时保持空选择", () => {
    expect(chooseInitialThread([thread("archived", "archived"), thread("active")])).toBe("active");
    expect(chooseInitialThread([thread("archived", "archived")])).toBeUndefined();
  });
});
