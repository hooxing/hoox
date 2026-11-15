// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { AdminControlApi } from "./control-api.js";
import { InstallationProgress } from "./installation-progress.js";

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("首次运行配置进度", () => {
  it("区分配置与就绪，支持检查后进入工作台并保留沙箱步骤", async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    let configured = false;
    const api = {
      overview: vi.fn(async () => (configured ? { activeModel: {} } : {})),
      sandboxOverview: vi.fn(async () => (configured ? { routing: { targets: [{}] } } : {})),
    } as unknown as Pick<AdminControlApi, "overview" | "sandboxOverview">;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() =>
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <InstallationProgress api={api} />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    );
    await settle();
    expect(container.textContent).toContain("模型待配置");
    expect(container.textContent).toContain("沙箱待配置");
    expect(container.querySelector('a[href="/sandboxes?setup=1"]')).not.toBeNull();
    configured = true;
    act(() => container.querySelector("button")?.click());
    await settle();
    expect(container.textContent).toContain("必需配置已保存");
    expect(container.textContent).not.toContain("已就绪");
    expect(container.querySelector('a[href="/app"]')).not.toBeNull();
    vi.mocked(api.overview).mockRejectedValueOnce(new Error("temporary"));
    act(() => container.querySelector("button")?.click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("暂时无法检查配置");
    act(() => root.unmount());
    client.clear();
  });
});
