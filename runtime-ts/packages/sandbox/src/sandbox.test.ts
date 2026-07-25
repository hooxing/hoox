import { describe, expect, it } from "vitest";
import { FakeSandboxGateway } from "./fake.js";
import { SandboxRuntimeError, guardedOperation } from "./errors.js";
import { usingSandbox } from "./cube-gateway.js";

describe("Sandbox 稳定适配契约", () => {
  it("无论业务是否失败都清理创建的 Sandbox", async () => {
    const gateway = new FakeSandboxGateway();
    await expect(
      usingSandbox(gateway, { templateId: "fake" }, async (sandbox) => {
        await sandbox.writeFile("/tmp/a.txt", "a");
        throw new Error("业务失败");
      }),
    ).rejects.toThrow("业务失败");

    const [sandbox] = [...gateway.sandboxes.values()];
    expect(sandbox?.killed).toBe(true);
  });

  it("pause/connect 保留文件并恢复可执行状态", async () => {
    const gateway = new FakeSandboxGateway();
    const first = await gateway.create({ templateId: "fake" });
    await first.writeFile("/tmp/a.txt", "content");
    await first.pause();
    await expect(first.command("pwd")).rejects.toMatchObject({ code: "UPSTREAM" });

    const resumed = await gateway.connect(first.id);
    expect(await resumed.readFile("/tmp/a.txt")).toBe("content");
    await resumed.kill();
  });

  it("映射取消、超时和不存在错误", async () => {
    const aborted = new AbortController();
    aborted.abort("用户取消");
    await expect(
      guardedOperation("测试", async () => 1, { signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(
      guardedOperation("测试", async () => new Promise(() => {}), { timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });

    const gateway = new FakeSandboxGateway();
    await expect(gateway.connect("missing")).rejects.toBeInstanceOf(SandboxRuntimeError);
    await expect(gateway.connect("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
