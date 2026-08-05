// @vitest-environment jsdom

import type { SkillPublicationStatus, SkillSubmissionDto } from "@cube-runtime/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./app.js";
import type { SkillAdminApiContract } from "./api.js";

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
    compatibility: "Cube Runtime >= 1",
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
  it("展示申请列表、摘要、SKILL.md、文件清单和驳回原因", async () => {
    const item = submission("rejected");
    const api = apiFixture(item);
    const container = mount(api);
    await settle();

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

  it("草稿提交时携带详情中的 expectedVersionToken", async () => {
    const item = submission("draft");
    const submitSubmission = vi.fn(async () => ({
      ...item,
      status: "submitted" as const,
      versionToken: 8,
    }));
    const api = apiFixture(item, { submitSubmission });
    const container = mount(api);
    await settle();

    await act(async () => button(container, "提交审核").click());
    expect(submitSubmission).toHaveBeenCalledWith(item.submissionId, {
      expectedVersionToken: 7,
    });
    expect(container.textContent).toContain("待审核");
  });

  it("审核、发布和撤销操作提供原因与推荐版本参数", async () => {
    const submitted = submission("submitted");
    const reviewSubmission = vi.fn(async () => ({
      ...submitted,
      status: "rejected" as const,
      rejectionReason: "缺少权限说明",
      versionToken: 8,
    }));
    const reviewApi = apiFixture(submitted, { reviewSubmission });
    const reviewContainer = mount(reviewApi);
    await settle();
    const rejection = reviewContainer.querySelector<HTMLTextAreaElement>(
      '.review-actions textarea[maxlength="2048"]',
    );
    if (rejection === null) throw new Error("未找到驳回原因输入框");
    act(() => changeControl(rejection, "  缺少权限说明  "));
    await act(async () => button(reviewContainer, "驳回申请").click());
    expect(reviewSubmission).toHaveBeenCalledWith(submitted.submissionId, {
      expectedVersionToken: 7,
      decision: "reject",
      reason: "缺少权限说明",
    });

    const approved = submission("approved");
    const publishSubmission = vi.fn(async () => ({
      ...approved,
      status: "published" as const,
      versionToken: 8,
    }));
    const publishContainer = mount(apiFixture(approved, { publishSubmission }));
    await settle();
    await act(async () => button(publishContainer, "发布技能").click());
    expect(publishSubmission).toHaveBeenCalledWith(approved.submissionId, {
      expectedVersionToken: 7,
      recommended: true,
    });

    const published = submission("published");
    const revokeSubmission = vi.fn(async () => ({
      ...published,
      status: "revoked" as const,
      versionToken: 8,
    }));
    const revokeContainer = mount(apiFixture(published, { revokeSubmission }));
    await settle();
    const revokeReason = revokeContainer.querySelector<HTMLTextAreaElement>(
      '.review-actions textarea[maxlength="2048"]',
    );
    if (revokeReason === null) throw new Error("未找到撤销原因输入框");
    act(() => changeControl(revokeReason, "上游已撤回"));
    await act(async () => button(revokeContainer, "撤销发布").click());
    expect(revokeSubmission).toHaveBeenCalledWith(published.submissionId, {
      expectedVersionToken: 7,
      reason: "上游已撤回",
    });
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
      版本: "2.0.0",
      描述: "新的技能说明",
      兼容性: "Cube Runtime >= 1",
      来源地址: "https://example.com/new-skill",
      来源修订: "v2.0.0",
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
      version: "2.0.0",
      description: "新的技能说明",
      compatibility: "Cube Runtime >= 1",
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
