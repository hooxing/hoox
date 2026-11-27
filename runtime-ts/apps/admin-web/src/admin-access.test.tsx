// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAccessGate } from "./admin-access.js";

let root: Root;
let container: HTMLDivElement;
const fetcher = vi.fn<typeof fetch>();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal("fetch", fetcher);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  fetcher.mockReset();
});
async function mount() {
  await act(async () => {
    root.render(
      <AdminAccessGate>
        <p>后台内容</p>
      </AdminAccessGate>,
    );
  });
}
async function submit() {
  await act(async () => {
    container
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
function fill(name: string, value: string) {
  (container.querySelector(`[name="${name}"]`) as HTMLInputElement).value = value;
}

describe("后台首次运行与登录", () => {
  it("空安装显示创建管理员及部署令牌，密码不一致时不提交", async () => {
    fetcher.mockResolvedValue(
      Response.json({ data: { initialized: false, setupTokenRequired: true } }),
    );
    await mount();
    expect(container.textContent).toContain("欢迎使用 Hoox");
    expect(container.querySelector('[name="setupToken"]')).not.toBeNull();
    fill("password", "test-password");
    fill("confirmation", "other-password");
    await submit();
    expect(container.textContent).toContain("两次输入的密码不一致");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("创建失败保留表单且不写入会话", async () => {
    fetcher
      .mockResolvedValueOnce(
        Response.json({ data: { initialized: false, setupTokenRequired: false } }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 409 }));
    await mount();
    fill("email", "setup@example.invalid");
    fill("password", "test-password");
    fill("confirmation", "test-password");
    await submit();
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/installation/administrator");
    expect(container.textContent).toContain("该实例已完成初始化");
    expect(localStorage.getItem("hoox.auth-session.v2")).toBeNull();
  });
  it("已初始化实例通过真实密码会话登录后台", async () => {
    fetcher
      .mockResolvedValueOnce(
        Response.json({ data: { initialized: true, setupTokenRequired: false } }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { accessToken: "hoox_session_test", expiresAt: "2099-01-01" } }),
      );
    await mount();
    fill("email", "setup@example.invalid");
    fill("password", "test-password");
    await submit();
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/installation/login");
    expect(container.textContent).toContain("后台内容");
    expect(JSON.parse(localStorage.getItem("hoox.auth-session.v2") ?? "{}").accessToken).toBe(
      "hoox_session_test",
    );
  });
  it("已有会话验证期间只显示加载态，验证成功后直接进入后台", async () => {
    const principal = Promise.withResolvers<Response>();
    localStorage.setItem(
      "hoox.auth-session.v2",
      JSON.stringify({ accessToken: "hoox_session_test", expiresAt: "2099-01-01" }),
    );
    fetcher
      .mockResolvedValueOnce(
        Response.json({ data: { initialized: true, setupTokenRequired: false } }),
      )
      .mockReturnValueOnce(principal.promise);
    await mount();
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/auth/admin-principal");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("管理员会话");
    expect(container.querySelector("form")).toBeNull();
    expect(container.textContent).not.toContain("首次运行");
    expect(container.textContent).not.toContain("管理员登录");
    await act(async () => principal.resolve(Response.json({ data: { userId: "user_admin" } })));
    expect(container.textContent).toBe("后台内容");
  });
  it.each([
    { expiresAt: "2000-01-01", expectProbe: false },
    { expiresAt: "2099-01-01", expectProbe: true },
  ])(
    "清理无效会话，只向服务端验证未过期的会话（$expectProbe）",
    async ({ expiresAt, expectProbe }) => {
      localStorage.setItem(
        "hoox.auth-session.v2",
        JSON.stringify({ accessToken: "hoox_session_old", expiresAt }),
      );
      fetcher
        .mockResolvedValueOnce(
          Response.json({ data: { initialized: true, setupTokenRequired: false } }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 401 }));
      await mount();
      expect(fetcher).toHaveBeenCalledTimes(expectProbe ? 2 : 1);
      expect(container.textContent).toContain("管理员登录");
      expect(container.textContent).not.toContain("后台内容");
      expect(localStorage.getItem("hoox.auth-session.v2")).toBeNull();
    },
  );
  it("连接失败显示重试入口", async () => {
    fetcher.mockRejectedValue(new Error("unavailable"));
    await mount();
    expect(container.textContent).toContain("无法连接初始化服务");
    expect(container.querySelector("button")?.textContent).toBe("重新连接");
  });
});
