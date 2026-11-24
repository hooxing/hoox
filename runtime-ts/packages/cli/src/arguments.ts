import { parseArgs } from "node:util";
import { CliError } from "./errors.js";

export const help = `用法：
  hoox validate <file.yaml> [--remote] [--definition <id> --expected-generation <n>]
  hoox push <file.yaml> [--definition <id>] [--expected-generation <n>] [--dry-run]
  hoox pull <definitionId> [--revision <id>] [-o <file>]

公共参数：--json、--token-file <file>、--help
环境变量：HOOX_URL（后台地址）、HOOX_TOKEN（后台 Bearer 凭据）
push 只创建草稿，不自动发布。pull 默认导出当前已发布版本；-o 不覆盖已有文件。
退出码：0 成功，1 参数错误，2 校验失败，3 认证/授权失败，4 网络/服务错误，5 文件错误。
`;

const common = ["json", "token-file", "help"];
const allowed: Record<string, readonly string[]> = {
  validate: [...common, "remote", "definition", "expected-generation"],
  push: [...common, "definition", "expected-generation", "dry-run"],
  pull: [...common, "revision", "output"],
};
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/;

export function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}

function usage(): never {
  throw new CliError("usage", "INVALID_ARGUMENTS", "参数无效，请运行 hoox --help");
}

export function parseArguments(args: readonly string[]) {
  const parsed = (() => {
    try {
      return parseArgs({
        args: [...args],
        allowPositionals: true,
        strict: true,
        tokens: true,
        options: {
          json: { type: "boolean" },
          help: { type: "boolean" },
          remote: { type: "boolean" },
          "dry-run": { type: "boolean" },
          definition: { type: "string" },
          "expected-generation": { type: "string" },
          revision: { type: "string" },
          output: { type: "string", short: "o" },
          "token-file": { type: "string" },
        },
      });
    } catch {
      return usage();
    }
  })();
  const { values, positionals, tokens } = parsed;
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) usage();
    seen.add(token.name);
  }
  if (values.help) return { command: "help" as const, json: values.json === true };
  const [command, target] = positionals;
  if (!command || !allowed[command] || positionals.length !== 2 || !target) usage();
  if ([...seen].some((name) => !allowed[command]?.includes(name))) usage();
  if (values.definition !== undefined && !validId(values.definition)) usage();
  if (values.revision !== undefined && !validId(values.revision)) usage();
  if (command === "pull" && !validId(target)) usage();
  if (
    command === "validate" &&
    !values.remote &&
    (values.definition || values["expected-generation"])
  )
    usage();
  const generation = values["expected-generation"];
  if (
    generation !== undefined &&
    (!/^(0|[1-9][0-9]*)$/.test(generation) || !Number.isSafeInteger(Number(generation)))
  )
    usage();
  if (values.definition !== undefined && generation === undefined) usage();
  if (values.definition === undefined && generation !== undefined && generation !== "0") usage();
  if (values.output === "" || values["token-file"] === "") usage();
  return {
    command: command as "validate" | "push" | "pull",
    target,
    json: values.json === true,
    remote: values.remote === true,
    dryRun: values["dry-run"] === true,
    definition: values.definition,
    expectedGeneration: generation === undefined ? undefined : Number(generation),
    revision: values.revision,
    output: values.output,
    tokenFile: values["token-file"],
  };
}
