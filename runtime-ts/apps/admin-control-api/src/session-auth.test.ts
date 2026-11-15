import { describe, expect, it, vi } from "vitest";
import { createAdminSessionAuthResolver } from "./session-auth.js";

describe("管理 API 会话认证", () => {
  const context = { authorization: "Bearer hoox_session_test", requestId: "request-test" };
  it("使用主 API 确认管理员身份，不信任浏览器声称的身份", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { userId: "user_administrator" } }));
    const auth = createAdminSessionAuthResolver("http://127.0.0.1:3001", undefined, fetcher);
    expect(await auth.resolve(context)).toEqual({ userId: "user_administrator" });
    expect(fetcher).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:3001/v1/auth/admin-principal"),
      expect.objectContaining({
        redirect: "error",
        headers: { authorization: context.authorization },
      }),
    );
  });
  it("过期或非管理员会话被拒绝，身份服务不可用不会降级开发身份", async () => {
    const fallback = { resolve: vi.fn() };
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const auth = createAdminSessionAuthResolver("http://127.0.0.1:3001", fallback, fetcher);
    expect(await auth.resolve(context)).toBeUndefined();
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    await expect(auth.resolve(context)).rejects.toThrow("ADMIN_IDENTITY_UNAVAILABLE");
    expect(fallback.resolve).not.toHaveBeenCalled();
  });
  it.each(["x".repeat(4097), JSON.stringify({ data: { userId: "../invalid" } }), "not-json"])(
    "身份响应超限或格式错误时失败关闭",
    async (body) => {
      const fallback = { resolve: vi.fn() };
      const auth = createAdminSessionAuthResolver(
        "http://127.0.0.1:3001",
        fallback,
        vi.fn().mockResolvedValue(new Response(body)),
      );
      await expect(auth.resolve(context)).rejects.toThrow();
      expect(fallback.resolve).not.toHaveBeenCalled();
    },
  );
});
