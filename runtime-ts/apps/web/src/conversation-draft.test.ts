// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDrafts, ConversationDrafts } from "./conversation-draft.js";

beforeEach(() => window.sessionStorage.clear());

describe("会话文字草稿", () => {
  it("刷新恢复并隔离账号、空间、新会话和既有会话", () => {
    const drafts = new ConversationDrafts("user_a");
    drafts.write(undefined, undefined, "新任务");
    drafts.write(undefined, "thread_1", "个人草稿");
    drafts.write("team_a", "thread_1", "团队草稿");
    const restored = new ConversationDrafts("user_a");
    expect(restored.read(undefined, undefined)).toBe("新任务");
    expect(restored.read(undefined, "thread_1")).toBe("个人草稿");
    expect(restored.read("team_a", "thread_1")).toBe("团队草稿");
    expect(new ConversationDrafts("user_b").read(undefined, "thread_1")).toBe("");
  });

  it("新会话创建后迁移草稿，重试仍可恢复，发送成功后只清理目标", () => {
    const drafts = new ConversationDrafts("user_a");
    drafts.write(undefined, undefined, "待重试");
    drafts.write(undefined, "other", "其他草稿");
    drafts.move(undefined, undefined, "created");
    expect(new ConversationDrafts("user_a").read(undefined, "created")).toBe("待重试");
    expect(drafts.read(undefined, undefined)).toBe("");
    drafts.write(undefined, "created", "");
    expect(new ConversationDrafts("user_a").read(undefined, "created")).toBe("");
    expect(drafts.read(undefined, "other")).toBe("其他草稿");
  });

  it("退出只删除当前账号草稿", () => {
    new ConversationDrafts("user_a").write(undefined, "one", "a");
    new ConversationDrafts("user_b").write(undefined, "one", "b");
    clearAccountDrafts("user_a");
    expect(new ConversationDrafts("user_a").read(undefined, "one")).toBe("");
    expect(new ConversationDrafts("user_b").read(undefined, "one")).toBe("b");
  });

  it("存储失败保留内存输入并报告无法持久化", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      const drafts = new ConversationDrafts("user_a");
      drafts.write(undefined, undefined, "不要丢失");
      drafts.move(undefined, undefined, "created");
      expect(drafts.read(undefined, "created")).toBe("不要丢失");
      expect(drafts.persistenceFailed).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
