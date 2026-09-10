import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

/** 只固化现有有效加密根；不生成或轮换密钥，冲突时在写入前失败。 */
export function prepareDemoSandboxKey(directory) {
  const names = ["admin-control.env", "worker.env", "scheduler.env"];
  const files = names.map((name) => ({
    path: resolve(directory, name),
    values: parseEnv(readFileSync(resolve(directory, name), "utf8")),
  }));
  const keyName = "MODEL_CREDENTIAL_ENCRYPTION_KEY";
  const roots = files.map(
    ({ values }, index) => values[keyName] || (index < 2 ? values.MODEL_API_KEY : undefined),
  );
  const root = roots[0];
  if (
    !root ||
    Buffer.byteLength(root) < 32 ||
    /['\r\n]/.test(root) ||
    roots[1] !== root ||
    (roots[2] && roots[2] !== root)
  )
    throw new Error("Demo 加密根缺失或不一致；请保留原根并核对三个进程的配置");
  for (const file of files) {
    if (!file.values[keyName])
      appendFileSync(file.path, `\n${keyName}='${root}'\n`, { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    prepareDemoSandboxKey(process.argv[2] ?? "/config");
    console.log("Demo 共享加密根已核对并保留");
  } catch {
    console.error("Demo 加密根准备失败；未输出凭据，请检查原有配置一致性与文件权限");
    process.exitCode = 1;
  }
}
