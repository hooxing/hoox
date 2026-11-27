import type { Operations, RunDto, RunEventPageDto } from "./openapi.generated.js";

export type CreateThreadRequest = Operations["createThread"]["body"];
export type CreateRunRequest = Operations["createRun"]["body"];
export type SubmitToolResult = Operations["submitToolResult"]["body"];
export type PutRunFeedbackRequest = Operations["putRunFeedback"]["body"];
export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  idempotencyKey?: string;
};
export type RetryOptions = {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
};
export type IdempotentRequestOptions = RequestOptions & { idempotencyKey: string };
export type StreamOptions = RequestOptions & {
  lastEventId?: string;
  retry?: RetryOptions;
};
export type RunStreamEvent =
  | {
      event: "run-events";
      /** 续连游标；状态帧在序号 0 之前使用 `{attemptId}-start`，旧服务端可能不提供游标。 */
      id?: string;
      data: { run: RunDto; page: RunEventPageDto };
    }
  | { event: "end"; data: { reason: "settled" | "renew" } };
export type ClientToolAction = {
  threadId: string;
  runId: string;
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  deadline: string;
};
export type ClientToolContext = Omit<ClientToolAction, "toolName" | "arguments"> & {
  signal: AbortSignal;
};
export type ClientToolHandler = (
  argumentsValue: Record<string, unknown>,
  context: ClientToolContext,
) => string | Promise<string>;
