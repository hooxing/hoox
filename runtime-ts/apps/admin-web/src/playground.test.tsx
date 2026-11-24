// @vitest-environment jsdom

import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";
import { AdminControlApi } from "./control-api.js";
import { startPlaygroundRun } from "./playground-api.js";
import { button, enter, field, render, select, settle } from "./testing/admin-component.js";

const endpoint = "/api/v1/playground/runs";
const list = "/v1/admin/control/agent-definitions";
const receipt = {
  tenantId: "tenant_personal_receipt",
  threadId: "thread_receipt",
  runId: "run_receipt",
};
const token = "hoox_session_test-placeholder";
const input = {
  definitionId: "agent_first",
  revisionId: "rev_first_draft",
  message: "测试草稿回答",
  mocks: {},
};

function response(data: unknown) {
  return Response.json({ data });
}

function mount({
  canManage = true,
  accept = () => Promise.resolve(response(receipt)),
}: {
  canManage?: boolean;
  accept?: () => Promise<Response>;
} = {}) {
  const fetcher = vi.fn<typeof fetch>(async (path) => {
    if (path === "/v1/admin/control/access") return response({ allowed: true });
    if (path === list)
      return response({
        canManage,
        items: ["first", "second"].map((name) => ({
          definition: { id: `agent_${name}` },
          revision: { displayName: name },
        })),
      });
    for (const name of ["first", "second"]) {
      if (path === `${list}/agent_${name}/revisions`)
        return response({
          items: ["draft", "published", "revoked"].map((status, i) => ({
            id: `rev_${name}_${status}`,
            revision: 3 - i,
            status,
            displayName: name,
          })),
        });
    }
    if (path === endpoint) return accept();
    if (path === `/v1/admin/control/runs/${receipt.tenantId}/${receipt.runId}`)
      return response({
        run: {
          ...receipt,
          status: "succeeded",
          modelCalls: 1,
          toolCalls: 2,
          failedToolCalls: 0,
          attempts: [],
          usage: { inputTokens: 15, cacheReadTokens: 2, outputTokens: 7 },
        },
        contentAccess: false,
        timeline: { records: [], stats: {} },
      });
    throw Error("意外请求");
  });
  vi.stubGlobal("fetch", fetcher);
  const apiClient = {
    getPublicationAccess: async () => ({ role: "admin", namespaces: [] }),
  } as unknown as SkillAdminApiContract;
  const page = render(
    <App apiClient={apiClient} controlApi={new AdminControlApi()} initialPath="/playground" />,
  );
  return { page, fetcher };
}

async function chooseDraft(page: HTMLElement) {
  await settle();
  select(field<HTMLSelectElement>(page, "Agent"), input.definitionId);
  await settle();
  select(field<HTMLSelectElement>(page, "版本"), input.revisionId);
  enter(field<HTMLTextAreaElement>(page, "测试消息"), input.message);
}

async function submit(page: HTMLElement) {
  await act(async () => button(page, "发起运行").click());
  await settle();
}

beforeEach(() =>
  localStorage.setItem(
    "hoox.auth-session.v2",
    JSON.stringify({ accessToken: token, expiresAt: "2099-01-01T00:00:00Z" }),
  ),
);
afterEach(() => localStorage.clear());

describe("后台 Playground", () => {
  it("在 Mock 配置旁提示 Sandbox 命令仍可联网并产生真实外部副作用", async () => {
    const { page } = mount();
    await settle();
    const mocksField = field<HTMLTextAreaElement>(page, "工具 Mock（JSON 对象）");
    const helpId = mocksField.getAttribute("aria-describedby");
    expect(helpId).toBe("playground-mocks-help");
    expect(page.querySelector(`#${helpId}`)?.textContent).toContain(
      "Mock 仅覆盖已登记的外部工具与客户端工具；Sandbox 命令（含 Skill 脚本）仍可联网，可能产生真实外部副作用。",
    );
  });

  it("Agent 菜单直达；只读角色不能选版本或发起运行", async () => {
    const { page, fetcher } = mount({ canManage: false });
    await settle();
    expect(page.querySelector(".ant-menu-item-selected")?.textContent).toBe("Playground");
    expect(
      page
        .querySelector(".ant-menu-item-selected")
        ?.closest(".ant-menu-item-group")
        ?.querySelector(".ant-menu-item-group-title")?.textContent,
    ).toBe("Agent");
    expect(page.textContent).toContain("只有 Agent 管理员");
    expect(page.querySelector("form")).toBeNull();
    expect(
      fetcher.mock.calls
        .map(([path]) => path)
        .filter((path) => path !== "/v1/admin/control/access"),
    ).toEqual([list]);
  });

  it("随本次受理提交 Mock JSON，不自报来源或 Tenant；用受理结果定位 D1 详情", async () => {
    const { page, fetcher } = mount();
    await chooseDraft(page);
    const mocks = { client_lookup: { answer: "simulated" } };
    enter(field<HTMLTextAreaElement>(page, "工具 Mock（JSON 对象）"), JSON.stringify(mocks));
    await submit(page);
    const req = fetcher.mock.calls.find(([path]) => path === endpoint)?.[1];
    expect(req).toMatchObject({ method: "POST", cache: "no-store", credentials: "same-origin" });
    expect(JSON.parse(String(req?.body))).toEqual({ ...input, mocks });
    expect(new Headers(req?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(req?.headers).get("Idempotency-Key")).toBeTruthy();
    expect(new Headers(req?.headers).has("X-Tenant-Id")).toBe(false);
    expect(
      fetcher.mock.calls
        .map(([path]) => path)
        .filter((path) => path !== "/v1/admin/control/access"),
    ).toEqual([
      list,
      `${list}/agent_first/revisions`,
      endpoint,
      `/v1/admin/control/runs/${receipt.tenantId}/${receipt.runId}`,
    ]);
    expect(page.querySelector("aside.playground-trace")?.textContent).toContain("15 / 2 / 7");
    expect(page.querySelector(".run-detail")?.textContent).toContain(receipt.threadId);
    expect(page.querySelector(".run-detail")?.textContent).not.toContain("查看正文");
  });

  it("切换 Agent 时清空旧版本，空白消息和撤销版本不能发起运行", async () => {
    const { page, fetcher } = mount();
    await chooseDraft(page);
    select(field<HTMLSelectElement>(page, "Agent"), "agent_second");
    await settle();
    const revision = field<HTMLSelectElement>(page, "版本");
    expect(revision.value).toBe("");
    expect(revision.textContent).toContain("已发布");
    expect(
      revision.querySelector<HTMLOptionElement>('option[value="rev_second_revoked"]')?.disabled,
    ).toBe(true);
    expect(button(page, "发起运行").disabled).toBe(true);
    select(revision, "rev_second_published");
    enter(field<HTMLTextAreaElement>(page, "测试消息"), "   ");
    expect(button(page, "发起运行").disabled).toBe(true);
    expect(fetcher.mock.calls.some(([path]) => path === endpoint)).toBe(false);
  });

  it("受理结果未知时重用原幂等键，已成功后再次运行使用新键", async () => {
    const accept = vi
      .fn<() => Promise<Response>>()
      .mockRejectedValueOnce(Error("连接中断"))
      .mockImplementation(async () => response(receipt));
    const { page, fetcher } = mount({ accept });
    await chooseDraft(page);
    await submit(page);
    expect(page.textContent).toContain("未能确认运行是否已受理");
    expect(page.querySelector(".run-detail")).toBeNull();
    await submit(page);
    await submit(page);
    const keys = fetcher.mock.calls
      .filter(([path]) => path === endpoint)
      .map(([, init]) => new Headers(init?.headers).get("idempotency-key"));
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBeTruthy();
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).not.toBe(keys[2]);
  });

  it("主 API 拒绝后不读取轨迹，也不回退到普通 Run 入口", async () => {
    const { page, fetcher } = mount({ accept: async () => new Response(null, { status: 403 }) });
    await chooseDraft(page);
    await submit(page);
    expect(page.textContent).toContain("没有发起 Playground 运行的权限");
    expect(
      fetcher.mock.calls
        .map(([path]) => path)
        .filter((path) => path !== "/v1/admin/control/access"),
    ).toEqual([list, `${list}/agent_first/revisions`, endpoint]);
  });

  it("不使用缺失的会话，也不从不完整的受理结果推算 Tenant", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      response({ threadId: receipt.threadId, runId: receipt.runId }),
    );
    vi.stubGlobal("fetch", fetcher);
    await expect(startPlaygroundRun(input, "test-key")).rejects.toMatchObject({ status: 502 });
    localStorage.clear();
    await expect(startPlaygroundRun(input, "test-key")).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
