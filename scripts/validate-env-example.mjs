import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateEnvironmentExample } from "./env-contract.mjs";

export function validateComposePostgresBootstrap(source) {
  const values = Object.fromEntries(
    source.split(/\r?\n/u).flatMap((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
  try {
    const bootstrap = new URL(values.DATABASE_BOOTSTRAP_URL);
    if (
      bootstrap.username !== values.POSTGRES_BOOTSTRAP_USER ||
      decodeURIComponent(bootstrap.password) !== values.POSTGRES_BOOTSTRAP_PASSWORD
    ) {
      return ["DATABASE_BOOTSTRAP_URL 与 Compose PostgreSQL bootstrap 用户配置不一致"];
    }
  } catch {
    // 通用变量契约会报告缺失或格式问题；此处避免输出连接串内容。
  }
  return [];
}

export function validateExampleSource(source) {
  return [...validateEnvironmentExample(source), ...validateComposePostgresBootstrap(source)];
}

async function main() {
  // 该命令只读取可提交的示例文件，禁止读取真实 .env。
  const source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const issues = validateExampleSource(source);

  if (issues.length > 0) {
    for (const issue of issues) console.error(issue);
    process.exitCode = 1;
  } else {
    console.log("环境变量示例契约校验通过（未读取真实 .env）");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("环境变量示例校验失败");
    process.exitCode = 1;
  });
}
