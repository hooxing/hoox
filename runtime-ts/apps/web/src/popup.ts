export class PopupBlockedError extends Error {
  constructor() {
    super("浏览器阻止了新窗口，请允许弹出窗口后重试");
    this.name = "PopupBlockedError";
  }
}

type PendingWindow = Pick<Window, "close" | "location" | "opener">;

/** 必须在点击调用栈内先创建窗口；随后异步获取短期 URL 才不会被浏览器拦截。 */
export async function openResolvedUrl(
  openWindow: () => PendingWindow | null,
  resolveUrl: () => Promise<string>,
): Promise<void> {
  const popup = openWindow();
  if (popup === null) throw new PopupBlockedError();
  try {
    popup.opener = null;
  } catch {
    popup.close();
    throw new PopupBlockedError();
  }
  try {
    popup.location.replace(await resolveUrl());
  } catch (error) {
    popup.close();
    throw error;
  }
}
