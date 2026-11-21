// @vitest-environment jsdom

import type { AdminMcpDraftDto } from "@hoox/protocol";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { button, enter, field, render, select, settle } from "./testing/admin-component.js";
import type { SkillAdminApiContract } from "./api.js";
import { App } from "./app.js";

const draft: AdminMcpDraftDto = {
  draftId: "draft_1",
  source: "mcp",
  serverName: "docs",
  displayName: "文档检索",
  endpoint: "https://mcp.example.invalid/tools",
  timeoutMs: 1000,
  maxResponseBytes: 4096,
  sideEffect: "read_only",
  idempotent: true,
  credentialConfigured: false,
  generation: 1,
  publishedBatchCount: 0,
  createdAt: "2026-11-20",
  updatedAt: "2026-11-20",
};
const base = "/v1/admin/control/external-tools";
const overview = (d = draft) => ({ drafts: [d], batches: [] });
const firstTool = {
  accepted: true,
  modelToolName: "mcp__docs__find",
  remoteToolName: "find",
  description: "搜索",
  inputSchemaDigest: "a".repeat(64),
};
const batch = {
  batchId: "batch_1",
  displayName: "文档检索 v1",
  draftGeneration: 1,
  tools: [{ ...firstTool, toolVersionId: "tool_v1" }],
  endpoint: draft.endpoint,
  revoked: false,
};
const ok = (data: unknown) => Response.json({ data });
async function mount(initial: Response, path = "/external-tools") {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(initial);
  vi.stubGlobal("fetch", fetcher);
  const root = render(<App apiClient={{} as SkillAdminApiContract} initialPath={path} />);
  await settle();
  const click = async (name: string) => {
    act(() => button(root, name).click());
    await settle();
  };
  const fill = (name: string, value: string) =>
    enter(field<HTMLInputElement | HTMLTextAreaElement>(root, name), value);
  return { root, click, fill, fetcher };
}
function request(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, suffix: string, method: string) {
  const init = fetcher.mock.calls.find(
    ([url, init]) => url === base + suffix && init?.method === method,
  )?.[1];
  if (!init) throw new Error(`缺少 ${method} ${suffix} 请求`);
  expect(new Headers(init.headers).has("idempotency-key")).toBe(true);
  return JSON.parse(String(init.body));
}

describe("后台外部工具", () => {
  it.each(["/external-tools", "/external-tools/http-preview"])(
    "直接访问 %s 无管理权限时不渲染注册或预览表单",
    async (path) => {
      const { root, fetcher } = await mount(Response.json({ error: {} }, { status: 403 }), path);
      expect(root.querySelector(".ant-menu-item-selected")?.textContent).toContain("外部工具");
      expect(root.textContent).toContain("当前账号没有访问控制面的权限");
      expect(root.querySelector("form")).toBeNull();
      expect(root.textContent).not.toContain("新建 MCP 草稿");
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("新建草稿后单独写入凭据；失败信息不回显输入，清除凭据后才能改端点", async () => {
    const { root, click, fill, fetcher } = await mount(ok({ drafts: [], batches: [] }));
    await click("新建 MCP 草稿");
    fill("显示名称", draft.displayName);
    fill("Server 名称", draft.serverName);
    fill("HTTPS 端点", draft.endpoint);
    fetcher.mockResolvedValueOnce(ok(draft)).mockResolvedValueOnce(ok(overview()));
    await click("保存草稿");
    expect(request(fetcher, "/mcp-drafts", "POST")).toMatchObject({
      draftId: expect.any(String),
      expectedGeneration: 0,
      settings: { endpoint: draft.endpoint },
    });
    await click("写入凭据");
    const placeholder = "example-placeholder-only";
    fill("新凭据", placeholder);
    fetcher.mockResolvedValueOnce(
      Response.json({ error: { message: placeholder } }, { status: 400 }),
    );
    await click("保存凭据");
    expect(field<HTMLInputElement>(root, "新凭据").value).toBe("");
    expect(root.innerHTML.includes(placeholder)).toBe(false);
    fill("新凭据", placeholder);
    const configured = { ...draft, generation: 2, credentialConfigured: true };
    fetcher.mockResolvedValueOnce(ok(configured)).mockResolvedValueOnce(ok(overview(configured)));
    await click("保存凭据");
    expect(root.textContent).toContain("凭据已配置");
    expect(root.innerHTML.includes(placeholder)).toBe(false);
    await click("编辑设置");
    expect(field<HTMLInputElement>(root, "HTTPS 端点").readOnly).toBe(true);
    expect(root.textContent).toContain("先清除草稿凭据");
    await click("取消");
    fetcher.mockResolvedValueOnce(
      ok({ draftId: draft.draftId, generation: 2, publishable: true, tools: [firstTool] }),
    );
    await click("探测草稿");
    expect(button(root, "发布整批工具").disabled).toBe(false);
    await click("清除凭据");
    const cleared = { ...draft, generation: 3 };
    fetcher.mockResolvedValueOnce(ok(cleared)).mockResolvedValueOnce(ok(overview(cleared)));
    await click("确认清除");
    expect(button(root, "发布整批工具").disabled).toBe(true);
    expect(
      fetcher.mock.calls
        .filter(([url]) => url === `${base}/mcp-drafts/draft_1/credential`)
        .at(-1)?.[1]?.body,
    ).toBe(JSON.stringify({ expectedGeneration: 2, credential: null }));
    await click("编辑设置");
    expect(field<HTMLInputElement>(root, "HTTPS 端点").readOnly).toBe(false);
    fill("HTTPS 端点", "https://other.example.invalid/mcp");
    fetcher.mockResolvedValueOnce(ok(cleared)).mockResolvedValueOnce(ok(overview(cleared)));
    await click("保存草稿");
    expect(request(fetcher, "/mcp-drafts/draft_1", "PUT")).toMatchObject({
      expectedGeneration: 3,
      settings: { endpoint: "https://other.example.invalid/mcp" },
    });
  });
  it("探测列出通过与拒绝原因；全部通过后发布，撤销需要原因和确认", async () => {
    const { root, click, fill, fetcher } = await mount(ok(overview()));
    await click("管理草稿");
    expect(button(root, "发布整批工具").disabled).toBe(true);
    const report = {
      draftId: draft.draftId,
      generation: 1,
      publishable: false,
      tools: [
        firstTool,
        { accepted: false, remoteToolName: "unsupported", reasonMessage: "不支持的参数类型" },
      ],
    };
    fetcher.mockResolvedValueOnce(ok(report));
    await click("探测草稿");
    expect(root.textContent).toContain("不支持的参数类型");
    expect(root.textContent).toContain(firstTool.modelToolName);
    expect(button(root, "发布整批工具").disabled).toBe(true);
    fetcher.mockResolvedValueOnce(ok({ ...report, publishable: true, tools: [firstTool] }));
    await click("探测草稿");
    expect(button(root, "发布整批工具").disabled).toBe(false);
    const data = { drafts: [draft], batches: [batch] };
    fetcher.mockResolvedValueOnce(ok(batch)).mockResolvedValueOnce(ok(data));
    await click("发布整批工具");
    expect(request(fetcher, "/mcp-drafts/draft_1/publish", "POST")).toEqual({
      expectedGeneration: 1,
    });
    act(() => root.querySelector("summary")?.click());
    expect(root.textContent).toContain("tool_v1");
    await click("撤销批次");
    expect(root.textContent).toContain("引用这些版本的 Agent 草稿必须移除引用才能保存或发布");
    fill("撤销原因", "已下线");
    const revoked = { ...batch, revoked: true, revocationReason: "已下线" };
    fetcher
      .mockResolvedValueOnce(ok(revoked))
      .mockResolvedValueOnce(ok({ ...data, batches: [revoked] }));
    await click("确认撤销");
    expect(request(fetcher, "/batches/batch_1/revoke", "POST")).toEqual({ reason: "已下线" });
    expect(root.textContent).toContain("已撤销");
    expect(root.textContent).not.toContain("撤销批次");
  });
  it("HTTP 端点和 OpenAPI 只请求预览，切换声明不保留旧结果", async () => {
    const { root, click, fill, fetcher } = await mount(
      ok(overview()),
      "/external-tools/http-preview",
    );
    expect(root.textContent).toContain("发布即将支持");
    fill("工具名称", "search");
    fill("HTTPS 端点", draft.endpoint);
    const preview = {
      modelToolName: "http__search",
      method: "GET",
      endpoint: draft.endpoint,
      inputSchema: { type: "object" },
      inputSchemaDigest: "b".repeat(64),
      publishable: false,
    };
    fetcher.mockResolvedValueOnce(ok(preview));
    await click("生成预览");
    expect(root.textContent).toContain("http__search");
    expect(request(fetcher, "/http/preview", "POST")).toMatchObject({
      mode: "endpoint",
      method: "GET",
      inputSchema: { type: "object" },
    });
    select(field<HTMLSelectElement>(root, "声明方式"), "openapi");
    expect(root.textContent).not.toContain("http__search");
    fill("OpenAPI 片段", "[]");
    await click("生成预览");
    expect(root.textContent).toContain("请输入有效的 JSON 对象");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fill("OpenAPI 片段", '{"openapi":"3.0.0"}');
    fetcher.mockResolvedValueOnce(ok(preview));
    await click("生成预览");
    expect(JSON.parse(String(fetcher.mock.lastCall?.[1]?.body))).toEqual({
      toolName: "search",
      description: "",
      mode: "openapi",
      document: { openapi: "3.0.0" },
    });
    expect(root.querySelectorAll("button[type=submit]")).toHaveLength(1);
  });
});
