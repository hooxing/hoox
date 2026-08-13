import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const defaultGaiaService = "https://agents-course-unit4-scoring.hf.space";
const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "waiting"]);

function positiveInteger(raw, name, maximum) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} 必须是 1 到 ${maximum} 的整数`);
  }
  return value;
}

export function parseGaiaEvalArguments(argv, environment = process.env) {
  const options = {
    apiBaseUrl:
      environment.GAIA_EVAL_API_BASE_URL ??
      `http://${environment.API_LISTEN_HOST ?? "127.0.0.1"}:${environment.API_LISTEN_PORT ?? "3001"}`,
    authToken: environment.GAIA_EVAL_AUTH_TOKEN ?? "dev-user-a",
    questionsUrl: environment.GAIA_EVAL_QUESTIONS_URL ?? `${defaultGaiaService}/questions`,
    filesBaseUrl: environment.GAIA_EVAL_FILES_BASE_URL ?? `${defaultGaiaService}/files`,
    limit: 3,
    pollIntervalMs: 2_000,
    taskTimeoutMs: 20 * 60_000,
    outputDirectory: environment.GAIA_EVAL_OUTPUT_DIR ?? ".tmp/gaia-native-eval",
    taskIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--limit") {
      options.limit = positiveInteger(value, "--limit", 20);
      index += 1;
    } else if (argument === "--task-id") {
      if (typeof value !== "string" || value.trim() === "") throw new Error("--task-id 缺少值");
      options.taskIds.push(value.trim());
      index += 1;
    } else if (argument === "--poll-interval-ms") {
      options.pollIntervalMs = positiveInteger(value, "--poll-interval-ms", 60_000);
      index += 1;
    } else if (argument === "--task-timeout-ms") {
      options.taskTimeoutMs = positiveInteger(value, "--task-timeout-ms", 3_600_000);
      index += 1;
    } else if (argument === "--output-directory") {
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error("--output-directory 缺少值");
      }
      options.outputDirectory = value.trim();
      index += 1;
    } else {
      throw new Error(`未知参数：${argument}`);
    }
  }
  return Object.freeze({ ...options, taskIds: Object.freeze([...options.taskIds]) });
}

export function assertNativeEvalEnvironment(environment = process.env) {
  if (environment.MEM0_MEMORY_ENABLED !== "false") {
    throw new Error(
      "GAIA 原生评测要求进程级设置 MEM0_MEMORY_ENABLED=false；当前值不是明确的 false",
    );
  }
}

export function selectGaiaQuestions(questions, options) {
  const normalized = questions.filter(
    (question) => typeof question?.task_id === "string" && typeof question?.question === "string",
  );
  if (options.taskIds.length === 0) return normalized.slice(0, options.limit);
  const byId = new Map(normalized.map((question) => [question.task_id, question]));
  return options.taskIds.map((taskId) => {
    const question = byId.get(taskId);
    if (question === undefined) throw new Error(`题目列表中不存在 task_id=${taskId}`);
    return question;
  });
}

export function extractFinalAnswer(contextMessages, events) {
  const assistantMessages = contextMessages.filter(
    (message) => message?.role === "assistant" && typeof message?.text === "string",
  );
  const latest = assistantMessages.at(-1)?.text?.trim();
  if (latest) return latest;
  return events
    .filter((event) => event?.type === "message.delta" && typeof event?.payload?.delta === "string")
    .map((event) => event.payload.delta)
    .join("")
    .trim();
}

function mediaTypeFromResponse(response) {
  return (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "application/octet-stream"
  );
}

function safeFileName(question) {
  const configured = typeof question.file_name === "string" ? question.file_name.trim() : "";
  return configured || `${question.task_id}.bin`;
}

function idempotencyKey(kind, taskId) {
  return `gaia-${kind}-${taskId.slice(0, 12)}-${randomUUID()}`;
}

function summarizeEvents(events) {
  const count = (type) => events.filter((event) => event.type === type).length;
  const errors = events
    .filter((event) => event.type === "error")
    .map((event) => event.payload)
    .slice(-5);
  const runtimeNotices = events
    .filter((event) => event.type === "runtime.notice")
    .map((event) => event.payload)
    .slice(-5);
  const attemptStates = events
    .filter((event) => event.type === "attempt_state_changed")
    .map((event) => event.payload)
    .slice(-5);
  return {
    toolStarted: count("tool.started"),
    toolCompleted: count("tool.completed"),
    runtimeNotices,
    attemptStates,
    errors,
  };
}

export function evaluationStatus(run) {
  return run.executionStatus === "recovery_required" ? "recovery_required" : run.status;
}

export class GaiaRuntimeClient {
  constructor(options, fetchImplementation = fetch) {
    this.options = options;
    this.fetch = fetchImplementation;
  }

  async request(path, init = {}) {
    const response = await this.fetch(`${this.options.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.authToken}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => undefined);
    if (!response.ok || body?.data === undefined) {
      const code = body?.error?.code ?? `HTTP_${response.status}`;
      throw new Error(`${init.method ?? "GET"} ${path} 失败：${code}`);
    }
    return body.data;
  }

  async createThread(question) {
    return this.request("/v1/threads", {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey("thread", question.task_id) },
      body: JSON.stringify({ title: `GAIA Native L1 ${question.task_id.slice(0, 8)}` }),
    });
  }

  async uploadAttachment(question, body, mediaType) {
    const response = await this.fetch(`${this.options.apiBaseUrl}/v1/resources/uploads`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.authToken}`,
        "content-type": "application/octet-stream",
        "idempotency-key": idempotencyKey("upload", question.task_id),
        "x-file-name": encodeURIComponent(safeFileName(question)),
        "x-file-media-type": mediaType,
      },
      body,
    });
    const envelope = await response.json().catch(() => undefined);
    if (!response.ok || envelope?.data === undefined) {
      throw new Error(`附件上传失败：${envelope?.error?.code ?? `HTTP_${response.status}`}`);
    }
    return envelope.data;
  }

  async createRun(threadId, question, attachment) {
    if (attachment === undefined) {
      return this.request(`/v1/threads/${threadId}/runs`, {
        method: "POST",
        headers: { "idempotency-key": idempotencyKey("run", question.task_id) },
        body: JSON.stringify({ input: question.question }),
      });
    }
    const receipt = await this.request(`/v1/threads/${threadId}/inputs`, {
      method: "POST",
      headers: { "idempotency-key": idempotencyKey("input", question.task_id) },
      body: JSON.stringify({
        input: question.question,
        mode: "follow_up",
        attachments: [{ resourceId: attachment.resourceId, versionId: attachment.versionId }],
      }),
    });
    const queuedRun = receipt.queuedRun ?? { id: receipt.queuedRunId };
    if (typeof queuedRun.id !== "string") throw new Error("附件输入没有创建 queuedRun");
    return queuedRun;
  }

  async getRun(threadId, runId) {
    return this.request(`/v1/threads/${threadId}/runs/${runId}`);
  }

  async listContext(threadId) {
    const messages = [];
    let after = 0;
    while (true) {
      const page = await this.request(`/v1/threads/${threadId}/context?after=${after}&limit=500`);
      messages.push(...page.items);
      if (!page.hasMore || page.items.length === 0) return messages;
      after = page.items.at(-1).sequence;
    }
  }

  async listEvents(threadId, runId) {
    const events = [];
    let after = -1;
    while (true) {
      const page = await this.request(
        `/v1/threads/${threadId}/runs/${runId}/events?after=${after}&limit=200`,
      );
      events.push(...page.items);
      if (!page.hasMore || page.items.length === 0) return events;
      after = page.items.at(-1).sequence;
    }
  }
}

async function downloadAttachment(question, options, fetchImplementation) {
  if (typeof question.file_name !== "string" || question.file_name.trim() === "") return undefined;
  const response = await fetchImplementation(
    `${options.filesBaseUrl}/${encodeURIComponent(question.task_id)}`,
  );
  if (!response.ok) throw new Error(`GAIA 附件下载失败：HTTP_${response.status}`);
  return {
    body: new Uint8Array(await response.arrayBuffer()),
    mediaType: mediaTypeFromResponse(response),
  };
}

async function waitForTerminalRun(client, threadId, runId, options, sleep) {
  const deadline = Date.now() + options.taskTimeoutMs;
  while (Date.now() < deadline) {
    const run = await client.getRun(threadId, runId);
    if (terminalStatuses.has(run.status) || run.executionStatus === "recovery_required") return run;
    await sleep(options.pollIntervalMs);
  }
  throw new Error(`Run ${runId} 在 ${options.taskTimeoutMs}ms 内未结束`);
}

async function evaluateQuestion(question, options, dependencies) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  let thread;
  let run;
  try {
    thread = await dependencies.client.createThread(question);
    const downloaded = await downloadAttachment(question, options, dependencies.fetch);
    const attachment =
      downloaded === undefined
        ? undefined
        : await dependencies.client.uploadAttachment(
            question,
            downloaded.body,
            downloaded.mediaType,
          );
    run = await dependencies.client.createRun(thread.id, question, attachment);
    const terminalRun = await waitForTerminalRun(
      dependencies.client,
      thread.id,
      run.id,
      options,
      dependencies.sleep,
    );
    const [context, events] = await Promise.all([
      dependencies.client.listContext(thread.id),
      dependencies.client.listEvents(thread.id, run.id),
    ]);
    return {
      taskId: question.task_id,
      level: question.Level ?? question.level,
      fileName: question.file_name || undefined,
      threadId: thread.id,
      runId: run.id,
      status: evaluationStatus(terminalRun),
      runStatus: terminalRun.status,
      executionStatus: terminalRun.executionStatus,
      answer: extractFinalAnswer(context, events),
      diagnostics: summarizeEvents(events),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      taskId: question.task_id,
      level: question.Level ?? question.level,
      fileName: question.file_name || undefined,
      threadId: thread?.id,
      runId: run?.id,
      status: "harness_error",
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    };
  }
}

export async function runGaiaNativeEvaluation(options, dependencyOverrides = {}) {
  assertNativeEvalEnvironment(dependencyOverrides.environment ?? process.env);
  const fetchImplementation = dependencyOverrides.fetch ?? fetch;
  const response = await fetchImplementation(options.questionsUrl);
  if (!response.ok) throw new Error(`GAIA 题目列表获取失败：HTTP_${response.status}`);
  const questions = selectGaiaQuestions(await response.json(), options);
  if (questions.length === 0) throw new Error("GAIA 题目列表为空");
  const dependencies = {
    fetch: fetchImplementation,
    client: dependencyOverrides.client ?? new GaiaRuntimeClient(options, fetchImplementation),
    sleep:
      dependencyOverrides.sleep ??
      ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds))),
  };
  const startedAt = new Date().toISOString();
  const results = [];
  for (const question of questions) {
    process.stdout.write(`开始 GAIA ${question.task_id}\n`);
    const result = await evaluateQuestion(question, options, dependencies);
    results.push(result);
    process.stdout.write(`完成 GAIA ${question.task_id}：${result.status}\n`);
  }
  const report = {
    schemaVersion: 1,
    benchmark: "GAIA public Level 1 subset",
    mode: "native_runtime_unscored",
    questionsUrl: options.questionsUrl,
    apiBaseUrl: options.apiBaseUrl,
    principal: options.authToken === "dev-user-a" ? "dev-user-a" : "custom",
    memoryEnabled: false,
    modelId: (dependencyOverrides.environment ?? process.env).MODEL_ID,
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
  const outputDirectory = resolve(options.outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = resolve(outputDirectory, `gaia-native-${Date.now()}.json`);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return { report, outputPath };
}

async function main() {
  const options = parseGaiaEvalArguments(process.argv.slice(2));
  const { report, outputPath } = await runGaiaNativeEvaluation(options);
  const succeeded = report.results.filter((result) => result.status === "succeeded").length;
  process.stdout.write(`GAIA 原生评测完成：${succeeded}/${report.results.length} 个 Run 成功\n`);
  process.stdout.write(`报告：${outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
