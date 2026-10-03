import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("Demo 静态入口以可执行模块类型提供 PDF Worker，保留 nosniff", async () => {
  const root = await mkdtemp(join(tmpdir(), "hoox-static-test-"));
  await writeFile(join(root, "index.html"), "<!doctype html><title>Hoox</title>");
  const module = 'export const worker = "pdf";';
  await writeFile(join(root, "pdf.worker.mjs"), module);
  const child = spawn(process.execPath, ["scripts/demo-static-server.mjs"], {
    env: {
      ...process.env,
      STATIC_ROOT: root,
      STATIC_LISTEN_HOST: "127.0.0.1",
      STATIC_LISTEN_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const port = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("静态服务器启动超时")), 5000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("静态服务器提前退出"));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        const match = /127\.0\.0\.1:(\d+)/u.exec(chunk.toString());
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
    });
    const url = `http://127.0.0.1:${port}/pdf.worker.mjs`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(module);
    for (const path of ["/", "/app", "/app/", "/?error=access_denied"]) {
      const page = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page.headers.get("cache-control")).toBe("no-cache");
      expect(await page.text()).toContain("<title>Hoox</title>");
    }
    const head = await fetch(url, { method: "HEAD" });
    expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await head.text()).toBe("");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
