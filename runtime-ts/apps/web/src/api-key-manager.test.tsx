// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKey, RuntimeApi } from "./api.js";
import { ApiKeyManager } from "./api-key-manager.js";

const key: ApiKey = {
  id: "key_test",
  prefix: "hoox_sk_abcd",
  name: "部署机器人",
  scopes: ["threads:read"],
  createdAt: "2026-11-19T00:00:00.000Z",
};
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

describe("API Key 管理页", () => {
  it("创建后一次展示明文、提示复制并能吊销", async () => {
    const api = {
      listApiKeys: vi.fn(async () => ({ items: [key] })),
      createApiKey: vi.fn(async () => ({ key, token: "hoox_sk_one_time_secret" })),
      revokeApiKey: vi.fn(async () => key),
    } as unknown as RuntimeApi;
    await act(async () => root.render(<ApiKeyManager api={api} onClose={vi.fn()} />));
    const nameInput = container.querySelector('input[maxlength="120"]');
    if (!(nameInput instanceof HTMLInputElement)) throw new Error("名称输入框缺失");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "部署机器人");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      nameInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const form = container.querySelector("form");
    if (form === null) throw new Error("创建表单缺失");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.createApiKey).toHaveBeenCalledWith(expect.objectContaining({ name: "部署机器人" }));
    expect(container.textContent).toContain("hoox_sk_one_time_secret");
    expect(container.textContent).toContain("此后无法再次查看");
    expect(container.textContent).toContain("hoox_sk_abcd…");
    expect(container.textContent).not.toContain("token</");
    const revokeButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "吊销",
    );
    if (revokeButton === undefined) throw new Error("吊销按钮缺失");
    await act(async () => revokeButton.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(api.revokeApiKey).toHaveBeenCalledWith(key.id);
  });
});
