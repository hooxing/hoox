// @vitest-environment jsdom
import type { SandboxControlDto } from "@hoox/protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxConfigurationPanel } from "./sandbox-configuration-panel.js";

const policy = {
  templateId: "test-template",
  sessionTtlSeconds: 300,
  operationTimeoutMs: 30000,
  lifecycleTimeoutMs: 60000,
  pausedRetentionSeconds: 123,
  idleAction: "pause" as const,
};
function fixture() {
  const data: SandboxControlDto = {
    generation: 5,
    routing: {
      mode: "single",
      targets: [{ providerKey: "tencent-ags", profileRevision: 1, weight: 1 }],
    },
    profiles: [
      {
        revision: 1,
        createdAt: "2026-09-10T00:00:00.000Z",
        probeStatus: "healthy",
        configuration: {
          providerKey: "tencent-ags",
          displayName: "腾讯云",
          endpoint: "sandbox.example.test",
          credentialConfigured: true,
          policy,
        },
      },
      {
        revision: 1,
        createdAt: "2026-09-10T00:00:00.000Z",
        probeStatus: "healthy",
        configuration: {
          providerKey: "cube",
          displayName: "Cube",
          endpoint: "http://cube.example.test",
          credentialConfigured: false,
          policy,
        },
      },
    ],
  };
  return {
    data,
    api: {
      sandboxOverview: vi.fn(async () => data),
      saveSandboxProfile: vi.fn(),
      publishSandboxRouting: vi.fn(async () => data),
      probeSandboxProfile: vi.fn(async () => ({ healthy: true, durationMs: 1234 })),
    },
  };
}
async function mount(api: ReturnType<typeof fixture>["api"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<SandboxConfigurationPanel api={api} />));
  return {
    container,
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}
function element<T extends Element>(container: Element, selector: string): T {
  const found = container.querySelector<T>(selector);
  if (!found) throw new Error(`测试元素缺失：${selector}`);
  return found;
}
beforeEach(() => Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }));
describe("后台沙箱配置界面", () => {
  it("多供应商模式提交所选供应商、版本和权重", async () => {
    const { api } = fixture();
    const { container, close } = await mount(api);
    const mode = element<HTMLSelectElement>(container, 'select[aria-label="分配方式"]');
    act(() => {
      mode.value = "weighted";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    act(() => element<HTMLInputElement>(container, 'input[aria-label="启用 CubeSandbox"]').click());
    const probe = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "测试连接",
    );
    if (!probe) throw new Error("测试按钮缺失");
    await act(async () => probe.click());
    expect(mode.value).toBe("weighted");
    expect(
      element<HTMLInputElement>(container, 'input[aria-label="启用 CubeSandbox"]').checked,
    ).toBe(true);
    const apply = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "应用分配",
    );
    if (!apply) throw new Error("应用按钮缺失");
    await act(async () => apply.click());
    expect(api.publishSandboxRouting).toHaveBeenCalledWith({
      expectedGeneration: 5,
      configuration: {
        mode: "weighted",
        targets: [
          { providerKey: "tencent-ags", profileRevision: 1, weight: 1 },
          { providerKey: "cube", profileRevision: 1, weight: 1 },
        ],
      },
    });
    close();
  });
  it("编辑运行策略复用已配置密钥，页面没有凭据回显", async () => {
    const { api } = fixture();
    const { container, close } = await mount(api);
    const key = element<HTMLInputElement>(container, 'input[name="apiKey"]');
    expect(key.value).toBe("");
    expect(key.type).toBe("password");
    const ttl = element<HTMLInputElement>(container, 'input[name="sessionTtlSeconds"]');
    ttl.value = "900";
    const form = element<HTMLFormElement>(container, "form");
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(api.saveSandboxProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedGeneration: 5,
        reuseCredentialFromRevision: 1,
        configuration: expect.objectContaining({
          policy: expect.objectContaining({ sessionTtlSeconds: 900 }),
        }),
      }),
    );
    expect(api.saveSandboxProfile.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    close();
  });
  it("未测试配置不能发布，读取失败不显示假配置", async () => {
    const { api, data } = fixture();
    const first = data.profiles[0];
    if (!first) throw new Error("测试供应商缺失");
    first.probeStatus = "untested";
    const { container, close } = await mount(api);
    const apply = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "应用分配",
    );
    expect(apply?.disabled).toBe(true);
    close();
    api.sandboxOverview.mockRejectedValue(new Error("数据库不可用"));
    const failed = await mount(api);
    expect(failed.container.querySelector("form")).toBeNull();
    expect(failed.container.querySelector('[role="alert"]')).not.toBeNull();
    failed.close();
  });
});
