import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createHash, createHmac, hkdfSync } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requestMock = vi.hoisted(() => vi.fn());
vi.mock("node:https", () => ({ request: requestMock }));

import { normalizeExternalToolSchema } from "@hoox/domain";
import { ExternalToolTransportError } from "@hoox/run-contracts";
import { httpExternalToolTransport } from "./http-external-tool.js";

class FakeRequest extends EventEmitter {
  socket: { bytesWritten: number } = { bytesWritten: 100 };
  destroy(error: Error) {
    this.emit("error", error);
  }
  end(_body?: Buffer) {
    const response = new PassThrough() as PassThrough & {
      statusCode: number;
      headers: Record<string, string>;
    };
    response.statusCode = responseStatus;
    response.headers = { "content-type": responseType };
    responseCallback?.(response);
    queueMicrotask(() => {
      if (responseStatus < 300) response.end(responseBody);
      else response.end("secret error body");
    });
  }
}
let responseStatus = 200;
let responseType = "application/json";
let responseBody = Buffer.from('{"ok":true}');
let responseCallback:
  | ((response: PassThrough & { statusCode: number; headers: Record<string, string> }) => void)
  | undefined;

const schema = normalizeExternalToolSchema({
  type: "object",
  properties: { q: { type: "string" } },
  required: ["q"],
  additionalProperties: false,
});
const tool = {
  toolVersionId: "version-test",
  source: "http" as const,
  endpoint: "https://8.8.8.8/api?fixed=1",
  modelToolName: "http__lookup",
  description: "lookup",
  inputSchema: schema.schema,
  inputSchemaDigest: schema.digest,
  timeoutMs: 1000,
  maxResponseBytes: 128,
  sideEffect: "read_only" as const,
  idempotent: true,
  credentialRef: "placeholder-ref",
};
const target = {
  url: new URL(tool.endpoint),
  hostname: "8.8.8.8",
  servername: "8.8.8.8",
  hostHeader: "8.8.8.8",
  address: "8.8.8.8",
  addresses: ["8.8.8.8"],
};
const invocation = {
  tool,
  target,
  arguments: { q: "hello" },
  callContext: {
    tenantId: "tenant-internal",
    endUserId: "user-internal",
    threadId: "thread-internal",
    runId: "run-internal",
  },
  credential: "placeholder-secret",
  idempotencyKey: "call-key",
  method: "GET" as const,
  timeoutMs: 1000,
  maxResponseBytes: 128,
  redirect: "error" as const,
};

beforeEach(() => {
  requestMock.mockReset();
  responseStatus = 200;
  responseType = "application/json";
  responseBody = Buffer.from('{"ok":true}');
  requestMock.mockImplementation((options: Record<string, unknown>, callback: unknown) => {
    responseCallback = callback as typeof responseCallback;
    Object.assign(capturedOptions, options);
    return new FakeRequest();
  });
  for (const key of Object.keys(capturedOptions)) delete capturedOptions[key];
});
const capturedOptions: Record<string, unknown> = {};

describe("HTTP Transport", () => {
  it("发送签名、幂等键和不可逆上下文，并固定连接已校验 IP", async () => {
    await httpExternalToolTransport.invoke(invocation);
    const headers = capturedOptions.headers as Record<string, string>;
    expect(headers["X-Hoox-Idempotency-Key"]).toBe("call-key");
    expect(headers["X-Hoox-Timestamp"]).toMatch(/^\d{13}$/u);
    expect(headers["X-Hoox-Signature"]).toMatch(/^[0-9a-f]{64}$/u);
    for (const id of ["tenant-internal", "user-internal", "thread-internal", "run-internal"])
      expect(JSON.stringify(headers)).not.toContain(id);
    expect(capturedOptions.hostname).toBe("8.8.8.8");
    expect(capturedOptions.lookup).toBeTypeOf("function");
    expect(capturedOptions.maxRedirects).toBeUndefined();
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from("placeholder-secret"),
        Buffer.from("hoox-http-signature:version-test"),
        Buffer.from("hmac-sha256-v1"),
        32,
      ),
    );
    const body = Buffer.from("");
    const digest = createHash("sha256").update(body).digest("hex");
    const expected = createHmac("sha256", key)
      .update(`${headers["X-Hoox-Timestamp"]}\nGET\n/api?fixed=1&q=hello\n${digest}`)
      .digest("hex");
    expect(headers["X-Hoox-Signature"]).toBe(expected);
  });

  it("把 HTTP 4xx 归为 responded_failure，正文不会进入错误", async () => {
    responseStatus = 429;
    await expect(httpExternalToolTransport.invoke(invocation)).rejects.toMatchObject({
      disposition: "responded_failure",
      safeCode: "EXTERNAL_TOOL_REJECTED",
      message: "EXTERNAL_TOOL_REJECTED",
    });
  });

  it("拒绝重定向而不跟随 Location", async () => {
    responseStatus = 302;
    await expect(httpExternalToolTransport.invoke(invocation)).rejects.toMatchObject({
      disposition: "responded_failure",
      safeCode: "EXTERNAL_TOOL_REJECTED",
    });
    expect(requestMock).toHaveBeenCalledOnce();
  });

  it("HTTP 5xx、响应超限和超时均保持未分类 UNKNOWN 语义", async () => {
    responseStatus = 503;
    await expect(httpExternalToolTransport.invoke(invocation)).rejects.not.toBeInstanceOf(
      ExternalToolTransportError,
    );
    responseStatus = 200;
    responseBody = Buffer.alloc(129, 65);
    await expect(httpExternalToolTransport.invoke(invocation)).rejects.not.toBeInstanceOf(
      ExternalToolTransportError,
    );
    const timeoutRequest = new FakeRequest();
    requestMock.mockImplementationOnce(() => timeoutRequest);
    const promise = httpExternalToolTransport.invoke({ ...invocation, timeoutMs: 1 });
    await expect(promise).rejects.not.toBeInstanceOf(ExternalToolTransportError);
  });
});
