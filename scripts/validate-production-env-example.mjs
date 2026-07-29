import { readFileSync } from "node:fs";
import { validateProductionEnvironmentExample } from "./production-env-contract.mjs";

const issues = validateProductionEnvironmentExample(
  readFileSync(new URL("../deploy/production.env.example", import.meta.url), "utf8"),
);
if (issues.length > 0) {
  for (const issue of issues) console.error(`生产配置样例校验失败：${issue}`);
  process.exitCode = 1;
} else {
  console.log("生产配置样例校验通过");
}
