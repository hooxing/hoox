import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

async function withStaticServer(
  files: Record<string, string>,
  test: (url: string) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "hoox-static-test-"));
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(root, name), contents)),
  );
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
    await test(`http://127.0.0.1:${port}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}

it("Demo 静态入口以可执行模块类型提供 PDF Worker，保留旧 SPA 回退", async () => {
  const module = 'export const worker = "pdf";';
  await withStaticServer(
    { "index.html": "<!doctype html><title>Hoox</title>", "pdf.worker.mjs": module },
    async (origin) => {
      const url = `${origin}/pdf.worker.mjs`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe(module);
      for (const path of ["/", "/app", "/app/", "/?error=access_denied"]) {
        const page = await fetch(`${origin}${path}`);
        expect(page.status).toBe(200);
        expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(page.headers.get("cache-control")).toBe("no-cache");
        expect(await page.text()).toContain("<title>Hoox</title>");
      }
      const head = await fetch(url, { method: "HEAD" });
      expect(head.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await head.text()).toBe("");
      for (const path of ["/robots.txt", "/sitemap.xml"]) {
        expect((await fetch(`${origin}${path}`)).status).toBe(404);
      }
    },
  );
});

it("Demo 爬虫文件使用配置域名和正确的媒体类型，工作台不回退到首页", async () => {
  const [landing, workspace, robots, nginx] = await Promise.all([
    readFile("runtime-ts/apps/web/index.html", "utf8"),
    readFile("runtime-ts/apps/web/workspace.html", "utf8"),
    readFile("runtime-ts/apps/web/robots.txt", "utf8"),
    readFile("deploy/demo/nginx.conf.template", "utf8"),
  ]);
  expect(nginx).toContain("proxy_set_header X-Hoox-Public-Origin https://@@DOMAIN@@;");
  await withStaticServer(
    {
      "index.html": landing,
      "workspace.html": workspace,
      "robots.txt": robots,
      "sitemap.xml": '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    },
    async (origin) => {
      const publicOrigin = "https://hoox.example.org";
      const headers = { "x-hoox-public-origin": publicOrigin };
      const homepage = await (await fetch(`${origin}/?utm_source=github`, { headers })).text();
      expect(homepage).toContain(`<link rel="canonical" href="${publicOrigin}/"`);
      expect(homepage).toContain(`<meta property="og:url" content="${publicOrigin}/"`);
      expect(homepage).toContain(
        `<meta property="og:image" content="${publicOrigin}/brand/hoox-open-graph.png"`,
      );
      expect(homepage).toContain('<meta name="twitter:card" content="summary_large_image"');
      expect(await (await fetch(origin)).text()).not.toContain('rel="canonical"');
      expect(
        await (
          await fetch(origin, { headers: { "x-hoox-public-origin": `${publicOrigin}/app` } })
        ).text(),
      ).not.toContain('rel="canonical"');

      const robotsResponse = await fetch(`${origin}/robots.txt`, { headers });
      expect(robotsResponse.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(robotsResponse.headers.get("cache-control")).toBe("no-cache");
      expect(await robotsResponse.text()).toContain(`Sitemap: ${publicOrigin}/sitemap.xml`);
      const sitemap = await fetch(`${origin}/sitemap.xml`, { headers });
      expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
      expect(sitemap.headers.get("cache-control")).toBe("no-cache");
      expect(await sitemap.text()).toContain(`<loc>${publicOrigin}/</loc>`);

      for (const path of [
        "/app",
        "/app/",
        "/app/thread/123",
        "/?error=access_denied",
        "/index.html?error=",
      ]) {
        const page = await (await fetch(`${origin}${path}`, { headers })).text();
        expect(page).toContain('<meta name="robots" content="noindex, nofollow"');
        expect(page).not.toContain('rel="canonical"');
      }
    },
  );
});
