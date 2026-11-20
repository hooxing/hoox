import { createHash, createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createHttpExternalToolTransport,
  deriveHttpToolSigningKey,
  importOpenApiOperation,
  verifyHttpToolSignature,
} from "./http-external-tool.js";

describe("HTTP 外部工具签名与 OpenAPI 导入", () => {
  it("v1 签名格式可由业务方独立计算，并覆盖幂等键与全部身份头", () => {
    const key = deriveHttpToolSigningKey("placeholder-credential", "version-a");
    expect(key).toEqual(
      Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from("placeholder-credential"),
          Buffer.from("hoox-http-signature:version-a"),
          Buffer.from("hmac-sha256-v1"),
          32,
        ),
      ),
    );
    expect(key.equals(deriveHttpToolSigningKey("placeholder-credential", "version-b"))).toBe(false);
    const timestamp = "1790000000000";
    const path = "/v1/items?mode=full";
    const body = Buffer.from('{"id":1}');
    const ids = ["a", "b", "c", "d"].map((c) => c.repeat(64));
    const signed = [
      "hoox-http-signature-v1",
      timestamp,
      "POST",
      path,
      createHash("sha256").update(body).digest("hex"),
      "call-1",
      ...ids,
    ].join("\n");
    const headers = {
      "x-hoox-signature": `v1=${createHmac("sha256", key).update(signed).digest("hex")}`,
      "x-hoox-timestamp": timestamp,
      "x-hoox-idempotency-key": "call-1",
      "x-hoox-tenant": ids[0],
      "x-hoox-end-user": ids[1],
      "x-hoox-thread": ids[2],
      "x-hoox-run": ids[3],
    };
    const nowMs = Number(timestamp) + 1000;
    const check = (overrides: Partial<Parameters<typeof verifyHttpToolSignature>[0]>) =>
      verifyHttpToolSignature({ key, method: "post", path, body, headers, nowMs, ...overrides });
    expect(check({})).toBe(true);
    expect(check({ body: Buffer.from("{}") })).toBe(false);
    expect(check({ path: "/v1/items?mode=lite" })).toBe(false);
    expect(check({ headers: { ...headers, "x-hoox-thread": "e".repeat(64) } })).toBe(false);
    expect(check({ headers: { ...headers, "x-hoox-idempotency-key": "call-2" } })).toBe(false);
    expect(check({ nowMs: Number(timestamp) - 300_001 })).toBe(false);
    expect(
      check({
        headers: { ...headers, "x-hoox-signature": headers["x-hoox-signature"].slice(3) },
      }),
    ).toBe(false);
    expect(check({ headers: { ...headers, "X-Hoox-Run": ids[3] } })).toBe(false);
  });

  it("身份派生根密钥过短时拒绝创建 Transport", () => {
    expect(() => createHttpExternalToolTransport({ identityRootKey: Buffer.alloc(16) })).toThrow(
      "HTTP_TOOL_IDENTITY_ROOT_KEY_INVALID",
    );
  });

  it("接受单个受控 JSON operation，并按 GET 只读标记", () => {
    const imported = importOpenApiOperation({
      openapi: "3.0.3",
      server: "https://api.example.test/base/",
      path: "/items",
      method: "get",
      operation: { summary: "列出", responses: { "200": { $ref: "#/components/responses/X" } } },
    });
    expect(imported).toMatchObject({
      endpoint: "https://api.example.test/base/items",
      method: "GET",
      sideEffect: "read_only",
      idempotent: true,
    });
    const queryOperation = importOpenApiOperation({
      openapi: "3.0.3",
      server: "https://api.example.test?scope=public",
      path: "/items",
      method: "GET",
      operation: {
        parameters: [{ in: "query", name: "limit", required: true, schema: { type: "integer" } }],
      },
    });
    expect(queryOperation.endpoint).toBe("https://api.example.test/items?scope=public");
    expect(queryOperation.inputSchema).toMatchObject({ required: ["limit"] });
    expect(() =>
      importOpenApiOperation({
        openapi: "3.0.3",
        server: "https://api.example.test?scope=public",
        path: "/items",
        method: "GET",
        operation: { parameters: [{ in: "query", name: "scope", schema: { type: "string" } }] },
      }),
    ).toThrow("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
  });

  it("拒绝可能替换主机或逃逸 server 的路径与 server", () => {
    const base = { openapi: "3.0.3", method: "GET", operation: {} };
    for (const path of [
      "/items/{id}",
      "//evil.example/x",
      "/\\evil.example/x",
      "/\\\\evil.example",
      "/\t/evil.example",
      "/%2F%2Fevil.example",
      "/a/../b",
      "/./a",
      "/a?x=1",
      "/a#f",
      "/@evil.example",
      "items",
    ])
      expect(() =>
        importOpenApiOperation({ ...base, server: "https://api.example.test", path }),
      ).toThrow("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
    for (const server of [
      "http://api.example.test",
      "https://user:pw@api.example.test",
      "https://api.example.test#x",
      "https://api.example.test\\@evil.example",
      "https://{tenant}.example.test",
      "https://api.example.test/../",
    ])
      expect(() => importOpenApiOperation({ ...base, server, path: "/items" })).toThrow(
        "HTTP_OPENAPI_OPERATION_UNSUPPORTED",
      );
  });

  it("接受受控 POST Schema，拒绝引用、混用引用和白名单外字段", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    };
    const base = {
      openapi: "3.1.0",
      server: "https://api.example.test",
      path: "/items",
      method: "POST",
      operation: { requestBody: { required: true, content: { "application/json": { schema } } } },
    };
    expect(importOpenApiOperation(base).inputSchema).toMatchObject({ type: "object" });
    const variants: unknown[] = [
      { ...base, operation: { ...base.operation, parameters: [] } },
      { ...base, operation: { $ref: "#/paths/x", ...base.operation } },
      { ...base, operation: { ...base.operation, security: [] } },
      { ...base, operation: { requestBody: { $ref: "#/components/requestBodies/Item" } } },
      {
        ...base,
        operation: { requestBody: { $ref: "#/x", content: { "application/json": { schema } } } },
      },
      {
        ...base,
        operation: {
          requestBody: { content: { "application/json": { schema: { $ref: "#/x" } } } },
        },
      },
      {
        ...base,
        operation: {
          requestBody: {
            content: {
              "application/json": {
                schema: { ...schema, properties: { name: { $ref: "#/x", type: "string" } } },
              },
            },
          },
        },
      },
      {
        ...base,
        operation: {
          requestBody: { content: { "application/json": { schema, encoding: {} } } },
        },
      },
      { ...base, extra: true },
      {
        ...base,
        method: "GET",
        operation: { parameters: [{ $ref: "#/components/parameters/limit" }] },
      },
      {
        ...base,
        method: "GET",
        operation: {
          parameters: [{ $ref: "#/x", in: "query", name: "limit", schema: { type: "integer" } }],
        },
      },
      {
        ...base,
        method: "GET",
        operation: {
          parameters: [
            { in: "query", name: "limit", style: "deepObject", schema: { type: "integer" } },
          ],
        },
      },
    ];
    for (const variant of variants)
      expect(() => importOpenApiOperation(variant)).toThrow("HTTP_OPENAPI_OPERATION_UNSUPPORTED");
  });
});
