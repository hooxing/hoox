import { createHash, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { importOpenApiOperation, verifyHttpToolSignature } from "./http-external-tool.js";

describe("HTTP 外部工具签名与 OpenAPI 导入", () => {
  it("签名格式可由业务方独立计算并校验", () => {
    const key = Buffer.from("test-signing-key");
    const timestamp = "1790000000000";
    const method = "POST";
    const path = "/v1/items?mode=full";
    const body = Buffer.from('{"id":1}');
    const digest = createHash("sha256").update(body).digest("hex");
    const signature = createHmac("sha256", key)
      .update(`${timestamp}\n${method}\n${path}\n${digest}`)
      .digest("hex");
    expect(verifyHttpToolSignature({ key, timestamp, method, path, body, signature })).toBe(true);
    expect(
      verifyHttpToolSignature({ key, timestamp, method, path, body: Buffer.from("{}"), signature }),
    ).toBe(false);
    const versionKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from("placeholder-credential"),
        Buffer.from("hoox-http-signature:version-a"),
        Buffer.from("hmac-sha256-v1"),
        32,
      ),
    );
    const otherVersionKey = Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from("placeholder-credential"),
        Buffer.from("hoox-http-signature:version-b"),
        Buffer.from("hmac-sha256-v1"),
        32,
      ),
    );
    expect(versionKey.equals(otherVersionKey)).toBe(false);
  });

  it("接受单个受控 JSON operation，并按 GET 只读标记", () => {
    const imported = importOpenApiOperation({
      openapi: "3.0.3",
      server: "https://api.example.test",
      path: "/items",
      method: "get",
      operation: {},
    });
    expect(imported).toMatchObject({
      endpoint: "https://api.example.test/items",
      method: "GET",
      sideEffect: "read_only",
      idempotent: true,
    });
    const queryOperation = importOpenApiOperation({
      openapi: "3.0.3",
      server: "https://api.example.test",
      path: "/items",
      method: "GET",
      operation: {
        parameters: [{ in: "query", name: "limit", required: true, schema: { type: "integer" } }],
      },
    });
    expect(queryOperation.inputSchema).toMatchObject({ required: ["limit"] });
    expect(() =>
      importOpenApiOperation({
        openapi: "3.0.3",
        server: "https://api.example.test",
        path: "/items/{id}",
        method: "GET",
        operation: {},
      }),
    ).toThrow("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
  });

  it("接受受控 POST Schema，拒绝引用和参数结构", () => {
    const base = {
      openapi: "3.1.0",
      server: "https://api.example.test",
      path: "/items",
      method: "POST",
      operation: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { name: { type: "string" } },
                required: ["name"],
                additionalProperties: false,
              },
            },
          },
        },
      },
    };
    expect(importOpenApiOperation(base).inputSchema).toMatchObject({ type: "object" });
    expect(() =>
      importOpenApiOperation({ ...base, operation: { ...base.operation, parameters: [] } }),
    ).toThrow("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
    const refOperation = {
      ...base,
      operation: {
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
        },
      },
    };
    expect(() => importOpenApiOperation(refOperation)).toThrow();
  });
});
