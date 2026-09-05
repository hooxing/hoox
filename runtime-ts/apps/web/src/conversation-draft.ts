import { useMemo, useReducer } from "react";

const prefix = "hoox.conversation-draft.v1:";

function accountPrefix(userId: string): string {
  return `${prefix}${encodeURIComponent(userId)}:`;
}

export function clearAccountDrafts(userId: string): void {
  try {
    const storage = window.sessionStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key?.startsWith(accountPrefix(userId))) storage.removeItem(key);
    }
  } catch {
    // 浏览器禁止存储时仍允许退出；内存草稿随工作台卸载释放。
  }
}

export class ConversationDrafts {
  private readonly values = new Map<string, string>();
  private readonly failedKeys = new Set<string>();

  get persistenceFailed(): boolean {
    return this.failedKeys.size > 0;
  }

  constructor(private readonly userId: string) {}

  private key(tenantId: string | undefined, threadId: string | undefined): string {
    return `${accountPrefix(this.userId)}${JSON.stringify([tenantId ?? null, threadId ?? null])}`;
  }

  read(tenantId: string | undefined, threadId: string | undefined): string {
    const key = this.key(tenantId, threadId);
    const cached = this.values.get(key);
    if (cached !== undefined) return cached;
    try {
      const value = window.sessionStorage.getItem(key) ?? "";
      this.values.set(key, value);
      return value;
    } catch {
      this.failedKeys.add(key);
      return "";
    }
  }

  write(tenantId: string | undefined, threadId: string | undefined, value: string): void {
    const key = this.key(tenantId, threadId);
    this.values.set(key, value);
    try {
      if (value === "") window.sessionStorage.removeItem(key);
      else window.sessionStorage.setItem(key, value);
      this.failedKeys.delete(key);
    } catch {
      this.failedKeys.add(key);
    }
  }

  move(tenantId: string | undefined, from: string | undefined, to: string): void {
    this.write(tenantId, to, this.read(tenantId, from));
    // 目标存储失败时保留来源，避免刷新后两个位置都没有草稿。
    if (!this.failedKeys.has(this.key(tenantId, to))) this.write(tenantId, from, "");
  }
}

/** 仅保存当前标签会话中的文字，按账号、空间和 Thread 隔离；文件需要重新选择。 */
export function useConversationDraft(
  userId: string,
  tenantId: string | undefined,
  threadId: string | undefined,
) {
  const drafts = useMemo(() => new ConversationDrafts(userId), [userId]);
  const [, refresh] = useReducer((version: number) => version + 1, 0);
  const input = drafts.read(tenantId, threadId);
  return {
    input,
    draftPersistenceFailed: drafts.persistenceFailed,
    setInput(value: string) {
      drafts.write(tenantId, threadId, value);
      refresh();
    },
    moveInputTo(targetThreadId: string) {
      drafts.move(tenantId, threadId, targetThreadId);
      refresh();
    },
    clearSentInput(targetThreadId: string) {
      drafts.write(tenantId, targetThreadId, "");
      refresh();
    },
  };
}
