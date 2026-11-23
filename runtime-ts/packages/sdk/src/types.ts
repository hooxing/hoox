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
  | { event: "run-events"; id?: string; data: { run: RunDto; page: RunEventPageDto } }
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
