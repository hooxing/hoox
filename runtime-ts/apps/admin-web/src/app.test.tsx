// @vitest-environment jsdom

import type { SkillPublicationStatus, SkillSubmissionDto } from "@hoox/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillAdminApiContract } from "./api.js";
import { App, browserRouterBasename } from "./app.js";
import { DEFAULT_BRANDING } from "@hoox/protocol";
import { BrandingProvider } from "@hoox/ui-theme/branding";

const digest = "b".repeat(64);
const roots: Root[] = [];

function submission(status: SkillPublicationStatus = "draft"): SkillSubmissionDto {
  return {
    submissionId: `submission_${status}`,
    canonicalKey: "code-review",
    displayName: "代码审阅",
    publisher: "Cube",
    version: "1.2.3",
    description: "按团队清单检查代码变更与安全边界。",
    compatibility: "Hoox >= 1",
    sourceUrl: "https://example.com/code-review",
    sourceRevision: "abc123",
    licenseSpdx: "MIT",
    status,
    securityStatus: "restricted",
    packageDigest: digest,
    entrypointDigest: digest,
    fileCount: 2,
    totalBytes: 48,
    versionToken: 7,
    createdBy: "user_admin",
    ...(status === "rejected" ? { rejectionReason: "入口说明不完整" } : {}),
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:01:00.000Z",
    files: [
      {
        path: "SKILL.md",
        mediaType: "text/markdown",
        sizeBytes: 24,
        contentDigest: digest,
      },
      {
        path: "references/checklist.md",
        mediaType: "text/markdown",
        sizeBytes: 24,
        contentDigest: digest,
      },
    ],
    entrypointMarkdown: "# 代码审阅\n\n遵循安全检查清单。",
  };
}

function apiFixture(
  item: SkillSubmissionDto,
  overrides: Partial<SkillAdminApiContract> = {},
): SkillAdminApiContract {
  return {
    listSubmissions: vi.fn(async () => ({ items: [item] })),
    getSubmission: vi.fn(async () => item),
    createSubmission: vi.fn(async () => item),
    submitSubmission: vi.fn(async () => ({
      ...item,
      status: "submitted" as const,
      versionToken: 8,
    })),
    reviewSubmission: vi.fn(async () => ({
      ...item,
      status: "approved" as const,
      versionToken: 8,
    })),
    publishSubmission: vi.fn(async () => ({
      ...item,
      status: "published" as const,
      versionToken: 8,
    })),
    revokeSubmission: vi.fn(async () => ({
      ...item,
      status: "revoked" as const,
      versionToken: 8,
    })),
    ...overrides,
  };
}

function mount(api: SkillAdminApiContract): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<App apiClient={api} />));
  return container;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => Promise.resolve());
  }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (match === undefined) throw new Error(`未找到按钮：${text}`);
  return match;
}

function changeControl(control: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    control instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(control, value);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("技能发布管理界面", () => {
  it("后台默认品牌 DOM 不变，定制产品名和主题同时生效", async () => {
    const api = apiFixture(submission());
    const baseline = mount(api);
    await settle();
    const before = baseline.querySelector(".platform-logo")?.innerHTML;
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () =>
      root.render(
        <BrandingProvider load={false}>
          <App apiClient={api} />
        </BrandingProvider>,
      ),
    );
    await settle();
    expect(host.querySelector(".platform-logo")?.innerHTML).toBe(before);
    await act(async () =>
      root.render(
        <BrandingProvider
          key="custom"
          load={false}
          initial={{ ...DEFAULT_BRANDING, productName: "定制后台", primaryColor: "#336699" }}
        >
          <App apiClient={api} />
        </BrandingProvider>,
      ),
    );
    expect(host.querySelector(".platform-logo")?.textContent).toContain("定制后台");
    expect(document.documentElement.style.getPropertyValue("--action-primary")).toBe("#336699");
  });
  it("真实后台缺少 Hoox 会话时展示工作台登录入口", () => {
    localStorage.clear();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => root.render(<App />));

    expect(container.querySelector('[aria-label="后台登录提示"]')?.textContent).toContain(
      "请先登录 Hoox 工作台",
    );
    expect(container.querySelector<HTMLAnchorElement>("a")?.getAttribute("href")).toBe("/");
  });

  it("把 Demo 子路径转换为 BrowserRouter basename", () => {
    expect(browserRouterBasename("/")).toBeUndefined();
    expect(browserRouterBasename("/admin/")).toBe("/admin");
    expect(() => browserRouterBasename("admin/")).toThrow(
      "后台管理 base URL 必须是以斜杠包围的绝对路径",
    );
  });

  it("发布者只看到自助 Skill 入口及其授权命名空间", async () => {
    const container = mount(
      apiFixture(submission(), {
        getPublicationAccess: vi.fn(async () => ({
          role: "publisher",
          namespaces: ["team-tools"],
        })),
      }),
    );
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Skill 自助发布");
    expect(container.querySelector(".platform-menu")?.textContent).toContain("Skill 发布");
    expect(container.querySelector(".platform-menu")?.textContent).not.toContain("身份与登录");
    expect(container.textContent).toContain("team-tools");
  });

  it("平台 Skill 管理员可以创建命名空间、授予并撤销发布者", async () => {
    const createNamespace = vi.fn(async () => ({ namespace: "new-team" }));
    const grantNamespace = vi.fn(async () => ({ granted: true }));
    const revokeNamespace = vi.fn(async () => ({ revoked: true }));
    const api = apiFixture(submission(), {
      getPublicationAccess: vi.fn(async () => ({ role: "admin", namespaces: ["team-tools"] })),
      listNamespaces: vi.fn(async () => [
        {
          namespace: "team-tools",
          createdBy: "user_admin",
          createdAt: "2026-11-24T00:00:00.000Z",
          publishers: [
            {
              userId: "user_publisher",
              grantedBy: "user_admin",
              grantedAt: "2026-11-24T00:00:00.000Z",
            },
          ],
        },
      ]),
      createNamespace,
      grantNamespace,
      revokeNamespace,
    });
    const container = mount(api);
    await settle();
    expect(container.textContent).toContain("命名空间与发布者");
    expect(container.textContent).toContain("team-tools");

    const nameInput = [...container.querySelectorAll<HTMLInputElement>("input")].find((input) =>
      input.closest("label")?.textContent?.includes("新建命名空间"),
    );
    if (nameInput === undefined) throw new Error("未找到命名空间名称输入框");
    act(() => changeControl(nameInput, "new-team"));
    const forms = container.querySelectorAll<HTMLFormElement>(".create-form");
    await act(async () =>
      forms[0]?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(createNamespace).toHaveBeenCalledWith("new-team");

    const publisherInput = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.closest("label")?.textContent?.includes("发布者用户 ID"),
    );
    if (publisherInput === undefined) throw new Error("未找到发布者用户 ID 输入框");
    act(() => changeControl(publisherInput, "user_new_publisher"));
    const grantForm = container.querySelectorAll<HTMLFormElement>(".create-form")[1];
    await act(async () =>
      grantForm?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(grantNamespace).toHaveBeenCalledWith("team-tools", "user_new_publisher");
    await act(async () => button(container, "撤销授权").click());
    expect(revokeNamespace).toHaveBeenCalledWith("team-tools", "user_publisher");
  });

  it("展示申请列表、摘要、SKILL.md、文件清单和驳回原因", async () => {
    const item = submission("rejected");
    const api = apiFixture(item);
    const container = mount(api);
    await settle();

    expect(
      container.querySelector<HTMLImageElement>(".platform-logo-mark")?.getAttribute("src"),
    ).toBe("/brand/hoox-app-icon.png");
    expect(container.querySelector(".eyebrow")?.textContent).toBe("Hoox");
    expect(api.listSubmissions).toHaveBeenCalledOnce();
    expect(api.getSubmission).toHaveBeenCalledWith(item.submissionId);
    expect(container.querySelector('[aria-label="发布申请列表"]')?.textContent).toContain(
      "代码审阅",
    );
    expect(container.querySelector('[aria-label="申请摘要"]')?.textContent).toContain(
      "按团队清单检查代码变更",
    );
    expect(container.querySelector('[aria-label="SKILL.md"] pre')?.textContent).toContain(
      "遵循安全检查清单",
    );
    expect(container.querySelector('[aria-label="文件清单"]')?.textContent).toContain(
      "references/checklist.md",
    );
    expect(container.querySelector('[aria-label="驳回原因"]')?.textContent).toContain(
      "入口说明不完整",
    );
  });

  it.each(["draft", "submitted", "approved"] as const)(
    "%s 可直接发布，自动推荐且不要求审核或版本选择",
    async (status) => {
      const item = submission(status);
      const api = apiFixture(item);
      const container = mount(api);
      await settle();
      expect(container.textContent).not.toContain("版本令牌");
      expect(container.textContent).not.toContain("提交审核");
      expect(container.textContent).not.toContain("批准申请");
      expect(container.querySelector('.action-panel input[type="checkbox"]')).toBeNull();
      await act(async () => button(container, "发布技能").click());
      expect(api.publishSubmission).toHaveBeenCalledWith(item.submissionId, {
        expectedVersionToken: 7,
        recommended: true,
      });
      expect(api.submitSubmission).not.toHaveBeenCalled();
      expect(api.reviewSubmission).not.toHaveBeenCalled();
      expect(container.textContent).toContain("已发布");
    },
  );

  it("下架只要求一次后果确认，不要求输入原因", async () => {
    const published = submission("published");
    const revokeSubmission = vi.fn(async () => ({
      ...published,
      status: "revoked" as const,
      versionToken: 8,
    }));
    const revokeContainer = mount(apiFixture(published, { revokeSubmission }));
    await settle();
    expect(revokeContainer.querySelector(".review-actions textarea")).toBeNull();
    await act(async () => button(revokeContainer, "下架技能").click());
    expect(revokeSubmission).not.toHaveBeenCalled();
    expect(revokeContainer.querySelector('[aria-label="下架确认"]')?.textContent).toContain(
      "已安装的此包也无法继续执行",
    );
    await act(async () => button(revokeContainer, "取消").click());
    expect(revokeSubmission).not.toHaveBeenCalled();
    await act(async () => button(revokeContainer, "下架技能").click());
    await act(async () => button(revokeContainer, "确认下架").click());
    expect(revokeSubmission).toHaveBeenCalledWith(published.submissionId, {
      expectedVersionToken: 7,
    });
  });

  it.each(["draft", "submitted", "revoked"] as const)(
    "最新上传为%s时仍可下架真正生效包，保持上传状态",
    async (status) => {
      const active = submission("published");
      const upload = {
        ...submission(status),
        submissionId: "submission_new_upload",
        versionToken: 3,
        currentPublished: { submissionId: active.submissionId, versionToken: active.versionToken },
      };
      const revokeSubmission = vi.fn(async () => ({
        ...active,
        status: "revoked" as const,
        versionToken: 8,
      }));
      const api = apiFixture(upload, { revokeSubmission });
      const container = mount(api);
      await settle();
      expect(
        container.querySelector('[aria-label="发布申请列表"]')?.querySelectorAll(".submission"),
      ).toHaveLength(1);
      await act(async () => button(container, "下架当前已发布内容").click());
      expect(revokeSubmission).not.toHaveBeenCalled();
      await act(async () => button(container, "确认下架").click());
      expect(revokeSubmission).toHaveBeenCalledExactlyOnceWith(active.submissionId, {
        expectedVersionToken: 7,
      });
      expect(api.publishSubmission).not.toHaveBeenCalled();
      expect(container.querySelector(".detail-header .status")?.textContent).toBe(
        status === "revoked" ? "已下架" : "待发布",
      );
      expect(container.textContent).not.toContain("下架当前已发布内容");
      expect(
        container.querySelector('[aria-label="发布申请列表"]')?.querySelectorAll(".submission"),
      ).toHaveLength(1);
    },
  );

  it.each(["published", "rejected", "revoked"] as const)(
    "%s 可上传替换包，沿用技能身份且不手填版本",
    async (status) => {
      const item = submission(status);
      const uploaded = {
        ...item,
        submissionId: "submission_uploaded_update",
        status: "draft" as const,
      };
      const api = apiFixture(item, {
        createSubmission: vi.fn(async () => uploaded),
        getSubmission: vi.fn(async (id) => (id === uploaded.submissionId ? uploaded : item)),
      });
      const container = mount(api);
      await settle();
      await act(async () => button(container, "上传更新").click());
      const form = container.querySelector<HTMLFormElement>(".create-form");
      if (form === null) throw new Error("未找到上传表单");
      expect(container.querySelector<HTMLDetailsElement>(".create-panel")?.open).toBe(true);
      const canonicalKey = form.querySelector<HTMLInputElement>(
        'input[pattern="[a-z0-9][a-z0-9._-]{0,127}"]',
      );
      expect(canonicalKey?.value).toBe(item.canonicalKey);
      expect(canonicalKey?.readOnly).toBe(true);
      expect(
        [...form.querySelectorAll("label")].some((label) => label.textContent?.trim() === "版本"),
      ).toBe(false);
      const markdown =
        "---\nname: different-key\npublisher: Someone Else\nversion: 1.2.3\ndescription: 更新后的技能说明\n---\n# Updated";
      const file = new File([markdown], "SKILL.md", { type: "text/markdown" });
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => new TextEncoder().encode(markdown).buffer,
      });
      const input = form.querySelector<HTMLInputElement>('input[type="file"]');
      if (input === null) throw new Error("未找到文件选择器");
      Object.defineProperty(input, "files", { configurable: true, value: [file] });
      act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
      await settle();
      await act(async () =>
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
      );
      await settle();
      expect(api.createSubmission).toHaveBeenCalledWith(
        expect.objectContaining({
          canonicalKey: item.canonicalKey,
          publisher: item.publisher,
          description: "更新后的技能说明",
        }),
      );
      expect(api.createSubmission).toHaveBeenCalledWith(
        expect.not.objectContaining({ version: expect.anything() }),
      );
      expect(api.publishSubmission).not.toHaveBeenCalled();
      expect(
        container.querySelector('[aria-label="发布申请列表"]')?.querySelectorAll(".submission"),
      ).toHaveLength(1);
      expect(container.querySelector(".detail-panel")?.textContent).toContain(
        "当前上传内容尚未发布",
      );
    },
  );

  it("选择标准 Skill 目录后从 SKILL.md 自动预填元数据", async () => {
    const listed = submission("draft");
    const createSubmission = vi.fn(async () => listed);
    const container = mount(apiFixture(listed, { createSubmission }));
    await settle();
    const markdown = `---
name: docx
description: "Create, edit, and inspect Word documents."
license: Proprietary. LICENSE.txt has complete terms
---

# DOCX`;
    const entrypoint = new File([markdown], "SKILL.md", { type: "text/markdown" });
    Object.defineProperty(entrypoint, "webkitRelativePath", {
      configurable: true,
      value: "docx/SKILL.md",
    });
    Object.defineProperty(entrypoint, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode(markdown).buffer,
    });
    const directoryInput = container.querySelector<HTMLInputElement>("input[webkitdirectory]");
    if (directoryInput === null) throw new Error("未找到目录选择器");
    Object.defineProperty(directoryInput, "files", {
      configurable: true,
      value: [entrypoint],
    });
    act(() => directoryInput.dispatchEvent(new Event("change", { bubbles: true })));
    await settle();

    const controlValue = (labelText: string) => {
      const label = [...container.querySelectorAll("label")].find((candidate) =>
        candidate.textContent?.includes(labelText),
      );
      return label?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type='file']), textarea",
      )?.value;
    };
    expect(controlValue("规范键")).toBe("docx");
    expect(controlValue("显示名称")).toBe("docx");
    expect(controlValue("描述")).toBe("Create, edit, and inspect Word documents.");
    expect(controlValue("SPDX 许可证")).toBe("LicenseRef-Proprietary");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "已从 SKILL.md 自动填写",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "完整条款仍以包内 LICENSE 文件",
    );

    const publisherControl = [...container.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.includes("发布者"))
      ?.querySelector<HTMLInputElement>("input");
    if (publisherControl == null) {
      throw new Error("未找到发布者输入框");
    }
    act(() => {
      changeControl(publisherControl, "Cube");
    });
    const form = container.querySelector<HTMLFormElement>(".create-form");
    if (form === null) throw new Error("未找到创建表单");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    await settle();
    expect(createSubmission).toHaveBeenCalledWith(
      expect.not.objectContaining({
        compatibility: expect.anything(),
        version: expect.anything(),
        sourceUrl: expect.anything(),
      }),
    );
  });

  it("创建表单提交全部元数据和浏览器编码后的多文件内容", async () => {
    const listed = submission("draft");
    const created = { ...listed, submissionId: "submission_created" };
    const createSubmission = vi.fn(async () => created);
    const api = apiFixture(listed, { createSubmission });
    const container = mount(api);
    await settle();

    const values: Readonly<Record<string, string>> = {
      规范键: "new-skill",
      显示名称: "新技能",
      发布者: "Cube",
      描述: "新的技能说明",
      上游仓库地址: "https://example.com/new-skill",
      "上游提交/版本": "v2.0.0",
      "SPDX 许可证": "Apache-2.0",
    };
    for (const [labelText, value] of Object.entries(values)) {
      const label = [...container.querySelectorAll("label")].find((candidate) =>
        candidate.textContent?.includes(labelText),
      );
      const control = label?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type='file']), textarea",
      );
      if (control === null || control === undefined) throw new Error(`未找到字段：${labelText}`);
      act(() => changeControl(control, value));
    }

    const first = new File(["# Skill"], "SKILL.md", { type: "text/markdown" });
    const second = new File(["guide"], "guide.md", { type: "text/markdown" });
    Object.defineProperty(first, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("# Skill").buffer,
    });
    Object.defineProperty(second, "arrayBuffer", {
      configurable: true,
      value: async () => new TextEncoder().encode("guide").buffer,
    });
    Object.defineProperty(second, "webkitRelativePath", {
      configurable: true,
      value: "new-skill/references/guide.md",
    });
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (fileInput === null) throw new Error("未找到文件选择器");
    Object.defineProperty(fileInput, "files", { configurable: true, value: [first, second] });
    act(() => fileInput.dispatchEvent(new Event("change", { bubbles: true })));

    const form = container.querySelector<HTMLFormElement>(".create-form");
    if (form === null) throw new Error("未找到创建表单");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await settle();

    expect(createSubmission).toHaveBeenCalledWith({
      canonicalKey: "new-skill",
      displayName: "新技能",
      publisher: "Cube",
      description: "新的技能说明",
      sourceUrl: "https://example.com/new-skill",
      sourceRevision: "v2.0.0",
      licenseSpdx: "Apache-2.0",
      files: [
        { path: "SKILL.md", mediaType: "text/markdown", contentBase64: "IyBTa2lsbA==" },
        {
          path: "new-skill/references/guide.md",
          mediaType: "text/markdown",
          contentBase64: "Z3VpZGU=",
        },
      ],
    });
  });
});
