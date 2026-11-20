// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeApi } from "./api.js";
import { WebhookManager } from "./webhook-manager.js";

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

describe("Webhook 管理页", () => {
  it("列出客户端工具事件并在创建后只展示一次签名密钥", async () => {
    const api = {
      listWebhooks: vi.fn(async () => ({ items: [] })),
      createWebhook: vi.fn(async () => ({
        webhook: {
          id: "wh_test",
          name: "运行回调",
          endpointUrl: "https://hooks.example.invalid/hoox",
          eventTypes: ["run.requires_action"],
          createdAt: "2026-11-20T00:00:00.000Z",
        },
        secret: "one_time_webhook_secret",
      })),
      rotateWebhookSecret: vi.fn(),
      disableWebhook: vi.fn(),
      deleteWebhook: vi.fn(),
    } as unknown as RuntimeApi;
    await act(async () => root.render(<WebhookManager api={api} onClose={vi.fn()} />));
    expect(container.textContent).toContain("客户端工具需要操作");

    const nameInput = container.querySelector('input[maxlength="120"]');
    const endpointInput = container.querySelector('input[type="url"]');
    if (!(nameInput instanceof HTMLInputElement) || !(endpointInput instanceof HTMLInputElement))
      throw new Error("Webhook 创建字段缺失");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(nameInput, "运行回调");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(endpointInput, "https://hooks.example.invalid/hoox");
      endpointInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = container.querySelector("form");
    if (form === null) throw new Error("Webhook 创建表单缺失");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.createWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "运行回调",
        endpointUrl: "https://hooks.example.invalid/hoox",
      }),
    );
    expect(container.textContent).toContain("one_time_webhook_secret");
    expect(container.textContent).toContain("此后无法再次查看");
  });
});
