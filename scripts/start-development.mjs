import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile, open } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseDotEnv(source) {
  return Object.fromEntries(
    source.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
      if (!match) return [];
      let value = match[2];
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      )
        value = value.slice(1, -1);
      return [[match[1], value]];
    }),
  );
}

export function parseArgs(args) {
  const options = { skipBuild: false, coreOnly: false, includeSkill: false, noBrowser: false };
  for (const arg of args) {
    const key = {
      "--skip-build": "skipBuild",
      "--core-only": "coreOnly",
      "--include-skill": "includeSkill",
      "--no-browser": "noBrowser",
    }[arg];
    if (!key) throw new Error(`未知启动参数：${arg}`);
    options[key] = true;
  }
  if (options.coreOnly && options.includeSkill)
    throw new Error("--core-only 与 --include-skill 不能同时使用");
  return options;
}

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ps = process.platform === "win32";
const run = (command, args, opts = {}) => {
  const result = spawnSync(command, args, { cwd: repo, stdio: "inherit", shell: ps, ...opts });
  if (result.status !== 0) throw new Error(`${command} 执行失败`);
};
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
async function healthy(url, timeout = 1000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    return response.ok;
  } catch {
    return false;
  }
}
async function portOpen(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(true));
    server.listen(port, "127.0.0.1", () => server.close(() => done(false)));
  });
}
async function waitReady(name, url, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await healthy(url)) {
      console.log(`[就绪] ${name} -> ${url}`);
      return true;
    }
    await sleep(500);
  }
  return false;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const envPath = resolve(repo, ".env");
  let env;
  try {
    env = parseDotEnv(await readFile(envPath, "utf8"));
  } catch {
    throw new Error("缺少 .env。请先复制 .env.example 并完成首次配置。");
  }
  const runtime = resolve(repo, ".tmp/development-runtime");
  await mkdir(runtime, { recursive: true });
  const apiPort = Number(env.API_LISTEN_PORT || 3001);
  const adminPort = Number(env.ADMIN_CONTROL_LISTEN_PORT || 3003);
  for (const [name, port] of [
    ["API_LISTEN_PORT", apiPort],
    ["ADMIN_CONTROL_LISTEN_PORT", adminPort],
  ])
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`${name} 不是有效端口`);

  if (!options.skipBuild) {
    console.log("[1/5] 构建工作区");
    run("corepack", ["pnpm", "build"]);
  } else console.log("[1/5] 已跳过构建");
  console.log("[2/5] 检查 .env 外部服务");
  run("node", ["runtime-ts/apps/agent-worker/dist/development-preflight-main.js"], {
    env: { ...process.env, ...env },
  });
  const withAdmin = !options.coreOnly;
  const services = [
    {
      name: "API",
      entry: "runtime-ts/apps/api/dist/development-main.js",
      url: `http://127.0.0.1:${apiPort}/live`,
      port: apiPort,
    },
    { name: "Agent Worker", entry: "runtime-ts/apps/agent-worker/dist/development-main.js" },
    { name: "Scheduler", entry: "runtime-ts/apps/scheduler/dist/development-main.js" },
    {
      name: "Web",
      command: ["pnpm", "--filter", "@hoox/web", "dev"],
      url: "http://127.0.0.1:4173",
      port: 4173,
    },
    ...(withAdmin
      ? [
          {
            name: "Admin API",
            entry: "runtime-ts/apps/admin-control-api/dist/development-main.js",
            url: `http://127.0.0.1:${adminPort}/live`,
            port: adminPort,
          },
          {
            name: "Admin Web",
            command: ["pnpm", "--filter", "@hoox/admin-web", "dev"],
            url: "http://127.0.0.1:4174/admin/",
            port: 4174,
          },
        ]
      : []),
  ];
  let previous = {};
  try {
    previous = JSON.parse(await readFile(resolve(runtime, "pids.json"), "utf8")).launched ?? {};
  } catch {}
  const started = {};
  const reused = [];
  for (const service of services) {
    if (service.url && (await healthy(service.url))) {
      reused.push(service.name);
      continue;
    }
    if (!service.url && previous[service.name]) {
      try {
        process.kill(previous[service.name], 0);
        reused.push(service.name);
        continue;
      } catch {}
    }
    if (service.port && (await portOpen(service.port)))
      throw new Error(
        `${service.name} 需要的端口 ${service.port} 已被占用但健康端点不可用；不会终止已有进程。`,
      );
    const log = resolve(runtime, `${service.name.toLowerCase().replaceAll(" ", "-")}.log`);
    const logHandle = await open(log, "a");
    await logHandle.write(`\n--- ${new Date().toISOString()} ---\n`);
    const command = service.entry ? "node" : "corepack";
    const args = service.entry ? [service.entry] : ["pnpm", ...service.command.slice(1)];
    const child = spawn(command, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      shell: ps,
    });
    try {
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once("spawn", resolveSpawn);
        child.once("error", rejectSpawn);
      });
    } catch (error) {
      await logHandle.close();
      throw new Error(`${service.name} 无法启动：${error.message}`);
    }
    child.unref();
    await logHandle.close();
    started[service.name] = child.pid;
    await writeFile(
      resolve(runtime, `${service.name.toLowerCase().replaceAll(" ", "-")}.pid`),
      String(child.pid),
    );
  }
  await writeFile(
    resolve(runtime, "pids.json"),
    JSON.stringify({ launched: { ...previous, ...started }, reused }, null, 2),
  );
  for (const service of services.filter((item) => item.url))
    if (!(await waitReady(service.name, service.url)))
      throw new Error(`${service.name} 未在超时时间内就绪；请检查 .tmp/development-runtime 日志。`);
  if (!options.noBrowser) {
    for (const target of [
      "http://127.0.0.1:4173/app",
      ...(withAdmin ? ["http://127.0.0.1:4173/admin/"] : []),
    ]) {
      if (ps)
        spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
      else
        spawn(process.platform === "darwin" ? "open" : "xdg-open", [target], {
          detached: true,
          stdio: "ignore",
        }).unref();
    }
  }
  console.log("Hoox 开发环境已全部启动；日志与状态位于 .tmp/development-runtime。");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
