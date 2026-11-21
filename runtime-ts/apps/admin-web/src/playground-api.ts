import { adminAuthorizationHeader } from "./admin-session.js";
import { AdminApiError } from "./api.js";

export interface PlaygroundInput {
  readonly definitionId: string;
  readonly revisionId: string;
  readonly message: string;
  readonly mocks?: Readonly<Record<string, unknown>>;
}

export interface PlaygroundReceipt {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
}

function isReceipt(value: unknown): value is PlaygroundReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    "tenantId" in value &&
    typeof value.tenantId === "string" &&
    value.tenantId !== "" &&
    "threadId" in value &&
    typeof value.threadId === "string" &&
    value.threadId !== "" &&
    "runId" in value &&
    typeof value.runId === "string" &&
    value.runId !== ""
  );
}

export async function startPlaygroundRun(
  { definitionId, revisionId, message, mocks = {} }: PlaygroundInput,
  idempotencyKey: string,
): Promise<PlaygroundReceipt> {
  const authorization = adminAuthorizationHeader();
  if (!authorization) throw new AdminApiError("管理员会话已失效，请重新登录。", 401, false);
  let response: Response;
  try {
    response = await fetch("/api/v1/playground/runs", {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ definitionId, revisionId, message, mocks }),
    });
  } catch {
    throw new AdminApiError("未能确认运行是否已受理，请用相同输入重试。", 0, true);
  }
  if (!response.ok) {
    const reason =
      response.status === 401 || response.status === 403
        ? "当前会话没有发起 Playground 运行的权限。"
        : response.status === 404 || response.status === 409
          ? "所选版本不可运行，请刷新版本列表后重试。"
          : response.status === 400
            ? "无法受理这条消息，请检查所选版本和消息。"
            : "未能确认运行是否已受理，请用相同输入重试。";
    throw new AdminApiError(reason, response.status, response.status >= 500);
  }
  const envelope: unknown = await response.json().catch(() => undefined);
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    !("data" in envelope) ||
    !isReceipt(envelope.data)
  ) {
    throw new AdminApiError("未收到完整的运行标识，请用相同输入重试。", 502, true);
  }
  return envelope.data;
}
