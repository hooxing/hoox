import type { ModelWireTraceCursor } from "@hoox/persistence/thread";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const maximumDecodedBytes = 1_024;
const maximumEncodedLength = 1_500;

interface CursorScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly runId: string;
}

interface CursorPayload extends CursorScope, ModelWireTraceCursor {
  readonly v: 1;
}

export class InvalidModelWireTraceCursorError extends Error {
  constructor() {
    super("模型网络诊断分页游标无效");
    this.name = "InvalidModelWireTraceCursorError";
  }
}

function invalid(): never {
  throw new InvalidModelWireTraceCursorError();
}

function validTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function parsePayload(value: unknown): CursorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const payload = value as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join(",") !==
      "attemptId,createdAt,modelTurn,part,runId,tenantId,threadId,transportAttempt,userId,v" ||
    payload.v !== 1 ||
    typeof payload.tenantId !== "string" ||
    typeof payload.userId !== "string" ||
    typeof payload.threadId !== "string" ||
    typeof payload.runId !== "string" ||
    typeof payload.attemptId !== "string" ||
    !idPattern.test(payload.tenantId) ||
    !idPattern.test(payload.userId) ||
    !idPattern.test(payload.threadId) ||
    !idPattern.test(payload.runId) ||
    !idPattern.test(payload.attemptId) ||
    typeof payload.createdAt !== "string" ||
    !validTimestamp(payload.createdAt) ||
    !Number.isSafeInteger(payload.modelTurn) ||
    (payload.modelTurn as number) < 0 ||
    !Number.isSafeInteger(payload.transportAttempt) ||
    (payload.transportAttempt as number) < 0 ||
    (payload.part !== "request" && payload.part !== "response")
  ) {
    invalid();
  }
  return payload as unknown as CursorPayload;
}

/**
 * 该游标只是同一个已授权 Run 内的排序位置，不是授权 capability；每一页仍重验认证、
 * Membership/RLS 与 Run 归属。载荷绑定 scope，篡改最多改变本 Run 的起始位置，不能扩大读取范围。
 */
export function encodeModelWireTraceCursor(
  scope: CursorScope,
  cursor: ModelWireTraceCursor,
): string {
  const payload: CursorPayload = { v: 1, ...scope, ...cursor };
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  if (bytes.byteLength > maximumDecodedBytes) invalid();
  return bytes.toString("base64url");
}

export function decodeModelWireTraceCursor(
  scope: CursorScope,
  value: string,
): ModelWireTraceCursor {
  if (value.length === 0 || value.length > maximumEncodedLength || !base64UrlPattern.test(value)) {
    invalid();
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength > maximumDecodedBytes || bytes.toString("base64url") !== value) {
      invalid();
    }
    const payload = parsePayload(JSON.parse(bytes.toString("utf8")));
    if (
      payload.tenantId !== scope.tenantId ||
      payload.userId !== scope.userId ||
      payload.threadId !== scope.threadId ||
      payload.runId !== scope.runId
    ) {
      invalid();
    }
    return Object.freeze({
      createdAt: payload.createdAt,
      attemptId: payload.attemptId,
      modelTurn: payload.modelTurn,
      transportAttempt: payload.transportAttempt,
      part: payload.part,
    });
  } catch (error) {
    if (error instanceof InvalidModelWireTraceCursorError) throw error;
    return invalid();
  }
}
