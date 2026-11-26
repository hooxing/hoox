import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { descriptorFor, type StableBlobPromotionAuthorizationPort } from "./blob-store.js";
import { createS3BlobStore, probeS3BlobStore, type S3ObjectClient } from "./s3-blob-store.js";
import { S3StableSkillPublisher } from "./skill-publication-object-store.js";
import {
  isOssEndpoint,
  parseS3ConditionalWrite,
  resolveS3ConditionalWrite,
  type S3ConditionalWrite,
} from "./s3-compatibility.js";

const config = {
  bucket: "test-bucket",
  region: "us-east-1",
  endpoint: "https://s3.example.invalid",
  accessKeyId: "test-access-placeholder",
  secretAccessKey: "test-secret-placeholder",
  maxBlobSizeBytes: 1024,
};
const clients: S3Client[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients.splice(0)) client.destroy();
});

function objectClient(endpoint: string, conditionalWrite?: S3ConditionalWrite) {
  const store = createS3BlobStore(
    { ...config, endpoint, ...(conditionalWrite === undefined ? {} : { conditionalWrite }) },
    {} as StableBlobPromotionAuthorizationPort,
  );
  const objects = Reflect.get(store, "client") as S3ObjectClient;
  const client = Reflect.get(objects, "client") as S3Client;
  clients.push(client);
  return { objects, client };
}

function transport(client: S3Client, respond: (headers: Record<string, string>) => unknown) {
  client.middlewareStack.add(
    () => async (args) => {
      const request = args.request as { headers: Record<string, string> };
      return { response: {}, output: { $metadata: {}, ...(respond(request.headers) as object) } };
    },
    { step: "finalizeRequest", name: "testTransport", priority: "low" },
  );
}

describe("S3 提供方兼容边界", () => {
  it.each([
    ["https://s3.example.invalid", undefined, "if-none-match"],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com", undefined, "oss-forbid-overwrite"],
    ["https://s3.example.invalid", "oss-forbid-overwrite", "oss-forbid-overwrite"],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com", "if-none-match", "if-none-match"],
    ["https://aliyuncs.com.example.invalid", undefined, "if-none-match"],
  ] as const)("条件写入检测与显式覆盖：%s / %s", async (endpoint, override, expected) => {
    const { objects, client } = objectClient(endpoint, override);
    transport(client, (headers) => {
      expect(headers["if-none-match"]).toBe(expected === "if-none-match" ? "*" : undefined);
      expect(headers["x-oss-forbid-overwrite"]).toBe(
        expected === "oss-forbid-overwrite" ? "true" : undefined,
      );
      if (expected === "oss-forbid-overwrite")
        expect(headers.authorization).toContain("x-oss-forbid-overwrite");
      expect(headers["content-type"]).toBe("text/plain");
      return {};
    });
    const body = Buffer.from("test");
    await objects.put({ key: "key", body, descriptor: descriptorFor(body, "text/plain") });
    expect(
      resolveS3ConditionalWrite({
        endpoint,
        ...(override === undefined ? {} : { conditionalWrite: override }),
      }),
    ).toBe(expected);
  });

  it("Skill 发布走相同的 OSS 条件写入 middleware", async () => {
    const publisher = new S3StableSkillPublisher({
      ...config,
      endpoint: "https://s3.oss-ap-northeast-2.aliyuncs.com",
    });
    const client = Reflect.get(publisher, "client") as S3Client;
    clients.push(client);
    let headers: Record<string, string> | undefined;
    client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === "HeadObjectCommand")
          throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
        return next(args);
      },
      { step: "initialize", name: "missingHead" },
    );
    transport(client, (requestHeaders) => {
      headers = requestHeaders;
      return {};
    });
    await expect(
      Reflect.get(publisher, "putStable").call(publisher, {
        body: Buffer.from("test"),
        digest: descriptorFor(Buffer.from("test"), "text/plain").sha256,
        mediaType: "text/plain",
      }),
    ).rejects.toThrow("HEAD 完整性校验失败");
    expect(headers?.["x-oss-forbid-overwrite"]).toBe("true");
    expect(headers?.["if-none-match"]).toBeUndefined();
  });

  it.each([
    [412, "PreconditionFailed", "BLOB_PRECONDITION_FAILED"],
    [409, "FileAlreadyExists", "BLOB_PRECONDITION_FAILED"],
    [409, "Conflict", "BLOB_PROVIDER_ERROR"],
    [403, "AccessDenied", "BLOB_PROVIDER_ERROR"],
  ])("条件写入错误仅按已存在语义映射：%s %s", async (status, name, code) => {
    const { objects, client } = objectClient(config.endpoint);
    transport(client, () => {
      throw Object.assign(new Error("provider"), { name, $metadata: { httpStatusCode: status } });
    });
    const body = Buffer.from("test");
    await expect(
      objects.put({ key: "key", body, descriptor: descriptorFor(body, "text/plain") }),
    ).rejects.toMatchObject({ code, result: "known" });
  });

  it.each([200, 404, 403, 500])("Blob readiness 对固定哨兵 HEAD：%s", async (status) => {
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async () => {
      if (status !== 200)
        throw Object.assign(new Error("probe"), { $metadata: { httpStatusCode: status } });
      return {};
    });
    if (status === 200 || status === 404)
      await expect(probeS3BlobStore(config)).resolves.toBeUndefined();
    else await expect(probeS3BlobStore(config)).rejects.toThrow("probe");
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0]?.[0] as HeadObjectCommand | undefined)?.input).toEqual({
      Bucket: config.bucket,
      Key: "__hoox_readiness__/nonexistent",
    });
  });

  it.each([
    ["https://s3.example.invalid", "text/html", "image/png", "inline", true],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com", "image/png", "image/png", "inline", false],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com", "text/html", "image/png", "attachment", false],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com", "text/html", "text/html", "attachment", false],
  ] as const)(
    "预签名类型策略：%s %s → %s",
    async (endpoint, storedMediaType, responseMediaType, disposition, override) => {
      const { objects } = objectClient(endpoint);
      const url = new URL(
        await objects.presignGet({
          key: "key",
          ttlSeconds: 60,
          storedMediaType,
          responseMediaType,
          delivery: "inline-preview",
        }),
      );
      expect(url.searchParams.has("response-content-type")).toBe(override);
      expect(url.searchParams.get("response-content-disposition")).toBe(disposition);
    },
  );

  it("拒绝无效枚举且不回显值；阿里云域名必须具有标签边界", () => {
    expect(() => parseS3ConditionalWrite("secret-invalid-placeholder")).toThrow(
      "S3 条件写入方式无效",
    );
    expect(isOssEndpoint("https://notaliyuncs.com")).toBe(false);
  });

  it.each([
    ["https://s3.oss-ap-northeast-2.aliyuncs.com.", true],
    ["https://S3.OSS-AP-NORTHEAST-2.ALIYUNCS.COM", true],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com:443", true],
    ["https://s3.oss-ap-northeast-2.aliyuncs.com.:8443", true],
    ["https://aliyuncs.com.evil.invalid", false],
    ["https://evil-aliyuncs.com", false],
    ["https://aliyuncs.com", false],
    ["http://127.0.0.1:19100", false],
  ])("端点 %s 的 OSS 识别为 %s（尾点、大小写、端口与伪造后缀）", (endpoint, expected) => {
    expect(isOssEndpoint(endpoint)).toBe(expected);
  });
});
