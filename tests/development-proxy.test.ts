import type { ClientRequest, IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { preserveInstallationSource as webSource } from "../runtime-ts/apps/web/vite.config.js";
import { preserveInstallationSource as adminSource } from "../runtime-ts/apps/admin-web/vite.config.js";

describe.each([
  ["工作台", webSource],
  ["后台", adminSource],
] as const)("%s 开发代理安装来源", (_name, preserve) => {
  it.each(["192.0.2.1", "::ffff:192.0.2.1", undefined])(
    "远程或未知 socket %s 不能被代理洗为本地请求",
    (remoteAddress) => {
      const setHeader = vi.fn();
      preserve(
        { setHeader } as unknown as ClientRequest,
        { socket: { remoteAddress }, headers: { host: "127.0.0.1" } } as unknown as IncomingMessage,
      );
      expect(setHeader).toHaveBeenCalledWith("x-forwarded-for", remoteAddress ?? "unknown");
    },
  );
  it.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "真实回环 %s 允许无令牌安装",
    (remoteAddress) => {
      const setHeader = vi.fn();
      preserve(
        { setHeader } as unknown as ClientRequest,
        { socket: { remoteAddress } } as unknown as IncomingMessage,
      );
      expect(setHeader).not.toHaveBeenCalled();
    },
  );
});
