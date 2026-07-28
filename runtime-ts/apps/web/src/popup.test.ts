import { describe, expect, it, vi } from "vitest";
import { openResolvedUrl, PopupBlockedError } from "./popup.js";

describe("openResolvedUrl", () => {
  it("弹窗被拦截时返回可见错误且不请求临时链接", async () => {
    const resolveUrl = vi.fn<() => Promise<string>>();
    await expect(openResolvedUrl(() => null, resolveUrl)).rejects.toBeInstanceOf(PopupBlockedError);
    expect(resolveUrl).not.toHaveBeenCalled();
  });

  it("临时链接失败时关闭已同步打开的空窗", async () => {
    const close = vi.fn();
    const replace = vi.fn();
    const popup = { close, location: { replace }, opener: {} };
    await expect(
      openResolvedUrl(
        () => popup as unknown as Window,
        async () => {
          throw new Error("失败");
        },
      ),
    ).rejects.toThrow("失败");
    expect(close).toHaveBeenCalledOnce();
    expect(replace).not.toHaveBeenCalled();
    expect(popup.opener).toBeNull();
  });
});
