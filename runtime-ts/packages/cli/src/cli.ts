import { randomUUID } from "node:crypto";
import {
  AGENT_CONFIGURATION_MAX_BYTES,
  AgentConfigurationError,
  parseAgentConfiguration,
} from "@hoox/protocol";
import { readCliTextFile, writeCliTextFile } from "@hoox/tool-router/cli-files";
import { help, parseArguments, validId } from "./arguments.js";
import { ControlClient, controlOrigin, fieldErrors, invalidResponse, record } from "./client.js";
import { CliError, exitCodes } from "./errors.js";

export interface CliDependencies {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetcher?: typeof fetch;
  readonly readFile?: typeof readCliTextFile;
  readonly writeFile?: typeof writeCliTextFile;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export async function runCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const stdout =
    dependencies.stdout ??
    ((text) => {
      process.stdout.write(text);
    });
  const stderr =
    dependencies.stderr ??
    ((text) => {
      process.stderr.write(text);
    });
  const read = dependencies.readFile ?? readCliTextFile;
  const write = dependencies.writeFile ?? writeCliTextFile;
  const secrets = new Set<string>(env.HOOX_TOKEN ? [env.HOOX_TOKEN, env.HOOX_TOKEN.trim()] : []);
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets) if (secret) result = result.split(secret).join("[REDACTED]");
    return result;
  };
  let json = args.includes("--json");
  try {
    const options = parseArguments(args);
    json = options.json;
    if (options.command === "help") {
      stdout(json ? `${JSON.stringify({ ok: true, help })}\n` : help);
      return 0;
    }
    const emit = (data: object, text: string) =>
      stdout(`${redact(json ? JSON.stringify({ ok: true, ...data }) : text)}\n`);
    let yaml: string | undefined;
    if (options.command !== "pull") {
      yaml = await readFile(options.target, AGENT_CONFIGURATION_MAX_BYTES, read);
      if (options.command === "validate" && !options.remote) {
        parseAgentConfiguration(yaml);
        emit({ valid: true, source: "local" }, "本地结构校验通过（未联网，未校验远程引用）");
        return 0;
      }
    }
    const origin = controlOrigin(env.HOOX_URL);
    const rawToken =
      options.tokenFile === undefined
        ? env.HOOX_TOKEN
        : await readFile(options.tokenFile, 8192, read);
    const token = rawToken?.trim();
    if (rawToken) secrets.add(rawToken);
    if (token) secrets.add(token);
    if (!token || token.length > 8192 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token))
      throw new CliError(
        "authentication",
        "INVALID_TOKEN",
        "请通过 HOOX_TOKEN 或 --token-file 提供有效的后台 Bearer 凭据",
      );
    if (yaml !== undefined) parseAgentConfiguration(yaml);
    const client = new ControlClient(
      origin,
      token,
      dependencies.fetcher ?? fetch,
      dependencies.sleep ??
        ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
    );
    if (options.command !== "pull") {
      const dryRun = options.command === "validate" || options.dryRun;
      const key = randomUUID();
      const data = record(
        await client.request(options.definition ? `/${options.definition}/import` : "/import", {
          key,
          body: {
            yaml,
            dryRun,
            ...(options.expectedGeneration === undefined
              ? {}
              : { expectedGeneration: options.expectedGeneration }),
          },
        }),
      );
      if (dryRun) {
        if (data.valid === false)
          throw new CliError(
            "validation",
            "INVALID_CONFIGURATION",
            "远程配置校验失败",
            fieldErrors(data.errors),
          );
        if (data.valid !== true) invalidResponse();
        emit({ valid: true, source: "remote" }, "远程校验通过，未创建或发布草稿");
      } else {
        const definition = options.definition === undefined ? record(data.definition) : undefined;
        const revision = definition === undefined ? data : record(data.revision);
        const definitionId = definition?.id ?? revision.definitionId;
        if (!validId(definitionId) || !validId(revision.id) || revision.status !== "draft")
          invalidResponse();
        emit(
          { definitionId, revisionId: revision.id, status: "draft", idempotencyKey: key },
          `Definition: ${definitionId}\nRevision: ${revision.id}\n状态：草稿（未发布）\nIdempotency-Key: ${key}`,
        );
      }
      return 0;
    }
    let revisionId = options.revision;
    if (revisionId === undefined) {
      const history = record(await client.request(`/${options.target}/revisions`));
      const definition = record(history.definition);
      if (!validId(definition.currentRevisionId))
        throw new CliError(
          "validation",
          "NO_PUBLISHED_REVISION",
          "该 Definition 没有当前已发布版本，请用 --revision 显式选择草稿",
        );
      revisionId = definition.currentRevisionId;
    }
    const exported = await client.request(`/${options.target}/revisions/${revisionId}/export`, {
      yaml: true,
    });
    if (typeof exported !== "string") invalidResponse();
    try {
      parseAgentConfiguration(exported);
    } catch (error) {
      if (error instanceof AgentConfigurationError) invalidResponse();
      throw error;
    }
    if (options.output !== undefined) {
      try {
        await write(options.output, exported);
      } catch {
        throw new CliError("file", "WRITE_FAILED", "无法写入输出文件；文件已存在时不会覆盖");
      }
      emit(
        { definitionId: options.target, revisionId, output: options.output },
        "YAML 已写入指定文件",
      );
    } else if (json) {
      emit({ definitionId: options.target, revisionId, yaml: exported }, "");
    } else {
      stdout(exported);
    }
    return 0;
  } catch (error) {
    const failure =
      error instanceof CliError
        ? error
        : error instanceof AgentConfigurationError
          ? new CliError(
              "validation",
              "INVALID_CONFIGURATION",
              "Agent 配置文件校验失败",
              fieldErrors(error.errors),
            )
          : new CliError("service", "INTERNAL_ERROR", "命令执行失败");
    const payload = {
      ok: false,
      error: {
        kind: failure.kind,
        code: failure.code,
        message: redact(failure.message),
        errors: failure.errors.map((item) => ({
          path: redact(item.path),
          code: redact(item.code),
          message: redact(item.message),
        })),
      },
    };
    if (json) stdout(`${JSON.stringify(payload)}\n`);
    else
      stderr(
        `${failure.code}: ${redact(failure.message)}\n${payload.error.errors.map((item) => `${item.path}: ${item.code}: ${item.message}\n`).join("")}`,
      );
    return exitCodes[failure.kind];
  }
}

async function readFile(
  path: string,
  limit: number,
  read: typeof readCliTextFile,
): Promise<string> {
  try {
    return await read(path, limit);
  } catch {
    throw new CliError(
      "file",
      "READ_FAILED",
      "无法读取文件：请确认文件存在、是 UTF-8 普通文件且未超出大小限制",
    );
  }
}
