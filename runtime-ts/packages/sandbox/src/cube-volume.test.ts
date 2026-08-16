import { tenantId } from "@aisay/domain";
import { describe, expect, it, vi } from "vitest";
import { CubeTenantResourceVolume } from "./cube-volume.js";

describe("Cube Tenant Resource Volume", () => {
  it("首次按 Tenant 创建固定 driver 的长期只读视图卷，并并发复用同一请求", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(
        Response.json({ volumeID: "tenant-volume-a", name: "tenant-volume-a", token: "" }),
      );
    const volumes = new CubeTenantResourceVolume(
      {
        apiUrl: "https://cube.invalid/",
        apiKey: "opaque-cube-key",
        driver: "runtime-resourcefs",
        requestTimeoutMs: 5_000,
      },
      fetcher,
    );

    const [first, second] = await Promise.all([
      volumes.ensure({ tenantId: tenantId("tenant-volume-a") }),
      volumes.ensure({ tenantId: tenantId("tenant-volume-a") }),
    ]);

    expect(first).toEqual({ name: "tenant-volume-a", path: "/resources" });
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://cube.invalid/volumes/tenant-volume-a");
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://cube.invalid/volumes");
    const request = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(request.body).toBe(
      JSON.stringify({ name: "tenant-volume-a", driver: "runtime-resourcefs" }),
    );
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer opaque-cube-key");
    expect(new Headers(request.headers).get("x-api-key")).toBe("opaque-cube-key");
  });

  it("并发创建冲突后只接受单查确认的同名卷", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(
        Response.json({ volumeID: "tenant-volume-race", name: "tenant-volume-race" }),
      );
    const volumes = new CubeTenantResourceVolume(
      { apiUrl: "http://cube.invalid", driver: "runtime-resourcefs" },
      fetcher,
    );

    await expect(volumes.ensure({ tenantId: tenantId("tenant-volume-race") })).resolves.toEqual({
      name: "tenant-volume-race",
      path: "/resources",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("拒绝身份漂移的 Volume 响应和不可投影 Tenant", async () => {
    const volumes = new CubeTenantResourceVolume(
      { apiUrl: "http://cube.invalid", driver: "runtime-resourcefs" },
      vi.fn(async () => Response.json({ volumeID: "other", name: "other" })),
    );

    await expect(
      volumes.ensure({ tenantId: tenantId("tenant-volume-mismatch") }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
    await expect(
      volumes.ensure({ tenantId: "tenant.invalid" as ReturnType<typeof tenantId> }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("readiness 只读探测 Cube 0.6 Volume API", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const volumes = new CubeTenantResourceVolume(
      { apiUrl: "http://cube.invalid", driver: "runtime-resourcefs" },
      fetcher,
    );

    await volumes.probe();

    expect(fetcher).toHaveBeenCalledWith(
      "http://cube.invalid/volumes",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("管控面网络超时映射为稳定错误且不回显上游正文", async () => {
    const volumes = new CubeTenantResourceVolume(
      {
        apiUrl: "http://cube.invalid",
        driver: "runtime-resourcefs",
        requestTimeoutMs: 5,
      },
      vi.fn(
        async (_url, init) =>
          new Promise<never>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("secret-upstream")), {
              once: true,
            });
          }),
      ),
    );

    await expect(volumes.probe()).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "Cube Volume 请求超时",
    });
  });
});
