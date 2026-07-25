import { readFile } from "node:fs/promises";
import { validateEnvironmentExample } from "./env-contract.mjs";

// 该命令只读取可提交的示例文件，禁止读取真实 .env。
const source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const issues = validateEnvironmentExample(source);

if (issues.length > 0) {
  for (const issue of issues) console.error(issue);
  process.exitCode = 1;
} else {
  console.log("环境变量示例契约校验通过（未读取真实 .env）");
}
