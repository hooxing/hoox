import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { resourceId, resourceVersionId, tenantId } from "@hoox/domain";
import {
  createResourceFilesystemCapabilityCodec,
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
} from "@hoox/resource";
import type { ExecutionScope } from "@hoox/run-contracts";
import type { SandboxHandle } from "@hoox/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerResourceFilesystemHttp } from "../../runtime-ts/apps/api/src/resource-filesystem-http.js";
import { ManagedResourceFilesystemSnapshotMaterializer } from "../../runtime-ts/apps/agent-worker/src/sandbox-resource-filesystem-materializer.js";
import {
  BlobStoreError,
  descriptorFor,
  type StableBlobPromotionAuthorizationPort,
  type StableBlobRef,
} from "../../runtime-ts/packages/persistence/src/blob-store.js";
import {
  type CreateS3BlobStoreConfig,
  createS3BlobStore,
  probeS3BlobStore,
  type S3BlobStore,
  type S3ObjectClient,
} from "../../runtime-ts/packages/persistence/src/s3-blob-store.js";
import { S3StableSkillPublisher } from "../../runtime-ts/packages/persistence/src/skill-publication-object-store.js";
import {
  applyS3ConditionalWrite,
  isOssEndpoint,
  isS3ObjectAlreadyExists,
  parseS3ConditionalWrite,
  resolveS3ConditionalWrite,
} from "../../runtime-ts/packages/persistence/src/s3-compatibility.js";
import { validateSkillPublicationPackage } from "../../runtime-ts/packages/skill/src/index.js";

const requiredVariables = [
  "S3_ENDPOINT",
  "S3_PUBLIC_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;
const configured = requiredVariables.every((name) => (process.env[name]?.trim().length ?? 0) > 0);
const prefix = `storage-conformance/${randomUUID()}`;
const scope = { tenantId: tenantId(`conformance-${randomUUID()}`) };
const largeBody = randomBytes(9 * 1024 * 1024 + 17);
const keys = new Set<string>();
const clients = new Set<S3Client>();
const unavailablePromotion: StableBlobPromotionAuthorizationPort = {
  claimPromotionExecution: unusedPromotion,
  resolveAuthorizedForCopy: unusedPromotion,
  markPromotionCopyIssued: unusedPromotion,
  completePromotionExecution: unusedPromotion,
};

let config: CreateS3BlobStoreConfig;
let blobs: S3BlobStore;
let objects: S3ObjectClient;
let sdk: S3Client;
let ossCompatibility: boolean;

describe.skipIf(!configured)("对象存储兼容性（真实生产 S3 客户端）", () => {
  beforeAll(
    () =>
      safely(async () => {
        config = {
          endpoint: defined(process.env.S3_ENDPOINT),
          publicEndpoint: defined(process.env.S3_PUBLIC_ENDPOINT),
          bucket: process.env.S3_BUCKET ?? "",
          region: process.env.S3_REGION ?? "",
          accessKeyId: defined(process.env.S3_ACCESS_KEY_ID),
          secretAccessKey: defined(process.env.S3_SECRET_ACCESS_KEY),
          forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
          ...(process.env.S3_CONDITIONAL_WRITE === undefined
            ? {}
            : { conditionalWrite: parseS3ConditionalWrite(process.env.S3_CONDITIONAL_WRITE) }),
          prefix,
          maxBlobSizeBytes: 16 * 1024 * 1024,
        };
        blobs = createS3BlobStore(config, unavailablePromotion);
        ossCompatibility =
          isOssEndpoint(config.endpoint) ||
          isOssEndpoint(config.publicEndpoint) ||
          config.conditionalWrite === "oss-forbid-overwrite";
        objects = Reflect.get(blobs, "client") as S3ObjectClient;
        sdk = Reflect.get(objects, "client") as S3Client;
        trackClient(sdk);
        clients.add(Reflect.get(objects, "presignClient") as S3Client);
        await probeS3BlobStore(config);
      }),
    120_000,
  );

  afterAll(
    () =>
      safely(async () => {
        try {
          const results = await Promise.allSettled(
            [...keys].map(async (key) => {
              await objects.delete(key);
              expect(await objects.head(key)).toBeUndefined();
            }),
          );
          expect(results.filter((result) => result.status === "rejected").length).toBe(0);
        } finally {
          for (const client of clients) client.destroy();
        }
      }),
    120_000,
  );

  for (const size of [0, 1024 * 1024, largeBody.byteLength]) {
    conformance(`Blob 往返、HEAD、幂等删除：${size} 字节`, async () => {
      const body = size === largeBody.byteLength ? largeBody : randomBytes(size);
      const staged = await blobs.putStaging({
        scope,
        purpose: "resource",
        uploadId: `upload-${randomUUID()}`,
        body,
        mediaType: "application/octet-stream",
      });
      expect(await blobs.head(scope, staged)).toMatchObject({ blob: staged });
      equalBytes(await blobs.getBytes(scope, staged), body);
      await blobs.deleteStaging(scope, staged);
      await blobs.deleteStaging(scope, staged);
      expect(await blobs.head(scope, staged)).toBeUndefined();
      expect(await blobFailure(() => blobs.getBytes(scope, staged))).toMatchObject({
        code: "BLOB_NOT_FOUND",
      });
    });
  }

  conformance("中文、空格、百分号和保留字符对象键的 PUT、GET、COPY、HEAD", async () => {
    const sourceKey = `${prefix}/键/中文 空格+%?#&='().txt`;
    const destinationKey = `${prefix}/复制/副本 +%?#.txt`;
    const body = Buffer.from("中文对象键与复制元数据\n");
    await objects.put({ key: sourceKey, body, descriptor: descriptorFor(body, "text/plain") });
    await objects.copy({ sourceKey, destinationKey });
    for (const key of [sourceKey, destinationKey]) {
      expect(await objects.head(key)).toMatchObject(descriptorFor(body, "text/plain"));
      const response = await sdk.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
      expect(response.ContentType).toBe("text/plain");
      expect(response.CacheControl).toBe("private, no-store");
      expect(response.Metadata?.sha256).toBe(hash(body));
      equalBytes(await defined(response.Body).transformToByteArray(), body);
    }
    const url = await objects.presignGet({
      key: destinationKey,
      ttlSeconds: 60,
      responseMediaType: "text/plain",
      delivery: "inline-preview",
    });
    equalBytes(new Uint8Array(await (await download(url)).arrayBuffer()), body);
  });

  conformance("条件写入首写成功、重复写拒绝且保留原字节", async () => {
    const key = `${prefix}/conditional/sequential`;
    const body = Buffer.from("first");
    const replacement = Buffer.from("replacement");
    await objects.put({ key, body, descriptor: descriptorFor(body, "text/plain") });
    expect(
      await blobFailure(() =>
        objects.put({
          key,
          body: replacement,
          descriptor: descriptorFor(replacement, "text/plain"),
        }),
      ),
    ).toEqual({ code: "BLOB_PRECONDITION_FAILED", result: "known" });
    const result = await objects.get(key);
    equalBytes(await collect(defined(result).body), body);
  });

  conformance("并发条件写只有一个成功，不覆盖赢家", async () => {
    const key = `${prefix}/conditional/concurrent`;
    const bodies = [Buffer.from("writer-one"), Buffer.from("writer-two")];
    const results = await Promise.allSettled(
      bodies.map((body) =>
        objects.put({ key, body, descriptor: descriptorFor(body, "text/plain") }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(blobErrorSemantics(rejected.reason)).toEqual({
        code: "BLOB_PRECONDITION_FAILED",
        result: "known",
      });
    }
    const winner = bodies[results.findIndex((result) => result.status === "fulfilled")];
    equalBytes(await collect(defined(await objects.get(key)).body), defined(winner));
  });

  conformance("生产 Blob 在真实 HEAD→PUT 竞争中把已存在收敛为相同内容幂等成功", async () => {
    const body = Buffer.from(`race-${randomUUID()}`);
    const uploadId = `upload-${randomUUID()}`;
    const race = missingHeadBarrier(sdk, (key) => key.endsWith(`/${uploadId}`));
    try {
      const input = {
        scope,
        purpose: "resource" as const,
        uploadId,
        body,
        mediaType: "text/plain",
      };
      const results = await settleAll([blobs.putStaging(input), blobs.putStaging(input)]);
      expect(results[0]).toEqual(results[1]);
      expect(race.conflicts()).toBe(1);
      equalBytes(await blobs.getBytes(scope, defined(results[0])), body);
      expect(
        await blobFailure(() => blobs.putStaging({ ...input, body: Buffer.from("different") })),
      ).toMatchObject({
        code: "BLOB_IDEMPOTENCY_CONFLICT",
      });
    } finally {
      race.remove();
    }
  });

  conformance("公网预签名 GET 的媒体类型与 UTF-8 附件下载策略", async () => {
    const body = Buffer.from("presigned public download\n");
    const stable = await stableResource(
      body,
      ossCompatibility ? "text/plain" : "application/octet-stream",
    );
    const url = await blobs.presignDownload({
      scope,
      blob: stable,
      ttlSeconds: 60,
      responseMediaType: "text/plain",
      downloadName: "中文 报告+%.txt",
    });
    const publicEndpoint = new URL(defined(config.publicEndpoint));
    const signedEndpoint = new URL(url);
    expect(signedEndpoint.searchParams.has("response-content-type")).toBe(!ossCompatibility);
    const publicHosts = config.forcePathStyle
      ? [publicEndpoint.hostname]
      : [publicEndpoint.hostname, `${config.bucket}.${publicEndpoint.hostname}`];
    expect(publicHosts).toContain(signedEndpoint.hostname);
    expect(signedEndpoint.protocol).toBe(publicEndpoint.protocol);
    expect(signedEndpoint.port).toBe(publicEndpoint.port);
    const response = await download(url);
    expect(response.headers.get("content-type")).toBe("text/plain");
    const disposition = response.headers.get("content-disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain("filename*=UTF-8''");
    expect(decodeURIComponent(disposition.split("filename*=UTF-8''")[1] ?? "")).toBe(
      "中文 报告+%.txt",
    );
    equalBytes(new Uint8Array(await response.arrayBuffer()), body);
    const mismatchUrl = await blobs.presignDownload({
      scope,
      blob: { ...stable, mediaType: "image/png" },
      ttlSeconds: 60,
      responseMediaType: "image/png",
      delivery: "inline-preview",
    });
    const mismatch = await download(mismatchUrl);
    expect(mismatch.headers.get("content-type")).toBe(
      ossCompatibility ? "text/plain" : "image/png",
    );
    expect(mismatch.headers.get("content-disposition")).toBe(
      ossCompatibility ? "attachment" : "inline",
    );
    equalBytes(new Uint8Array(await mismatch.arrayBuffer()), body);
  });

  conformance("预签名 GET 在真实时间过期后拒绝下载", async () => {
    const stable = await stableResource(Buffer.from("expiry"), "image/png");
    const url = await blobs.presignDownload({
      scope,
      blob: stable,
      ttlSeconds: 5,
      responseMediaType: "image/png",
      delivery: "inline-preview",
    });
    const initial = await download(url);
    expect(initial.headers.get("content-disposition")).toBe("inline");
    await initial.arrayBuffer();
    await setTimeout(6_100);
    const expired = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
    expect([400, 401, 403]).toContain(expired.status);
    await expired.body?.cancel();
  });

  for (const mode of ["WHEN_SUPPORTED", "WHEN_REQUIRED"] as const) {
    for (const streaming of [false, true]) {
      conformance(
        `SDK 校验和 ${mode}：${streaming ? "aws-chunked 流" : "缓冲 CRC32"}`,
        async () => {
          const client = new S3Client({
            region: sdk.config.region,
            credentials: sdk.config.credentials,
            endpoint: defined(config.endpoint),
            forcePathStyle: sdk.config.forcePathStyle,
            requestChecksumCalculation: mode,
            responseChecksumValidation: mode,
          });
          trackClient(client);
          let checksum = false;
          let chunked = false;
          client.middlewareStack.add(
            (next, context) => async (args) => {
              if (context.commandName === "PutObjectCommand") {
                const headers = (args.request as { headers: Record<string, string> }).headers;
                checksum =
                  "x-amz-checksum-crc32" in headers ||
                  headers["x-amz-trailer"] === "x-amz-checksum-crc32";
                chunked = headers["content-encoding"]?.includes("aws-chunked") ?? false;
              }
              return next(args);
            },
            { step: "finalizeRequest", name: "conformanceChecksum", priority: "low" },
          );
          const key = `${prefix}/checksums/${mode}/${streaming ? "stream" : "buffer"}`;
          const body = streaming ? Readable.from(bodyChunks(largeBody)) : largeBody;
          const command = new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentLength: largeBody.byteLength,
            ContentType: "application/octet-stream",
            Metadata: { sha256: hash(largeBody) },
          });
          applyS3ConditionalWrite(command, resolveS3ConditionalWrite(config));
          await client.send(command);
          expect(checksum).toBe(mode === "WHEN_SUPPORTED");
          expect(chunked).toBe(streaming && mode === "WHEN_SUPPORTED");
          const result = await client.send(
            new GetObjectCommand({
              Bucket: config.bucket,
              Key: key,
              ChecksumMode: "ENABLED",
            }),
          );
          equalBytes(await defined(result.Body).transformToByteArray(), largeBody);
          expect(result.ContentLength).toBe(largeBody.byteLength);
          expect(await objects.head(key)).toMatchObject(
            descriptorFor(largeBody, "application/octet-stream"),
          );
        },
      );
    }
  }

  conformance("Skill 规范包完整上传、读取、重复发布与真实条件写竞争", async () => {
    const publisher = new S3StableSkillPublisher(config);
    const client = Reflect.get(publisher, "client") as S3Client;
    trackClient(client, true);
    const race = missingHeadBarrier(client, (key) => key.includes("/stable/skill_catalog/skill/"));
    try {
      await publisher.probe();
      const publication = validateSkillPublicationPackage({
        metadata: {
          canonicalKey: "storage-conformance",
          displayName: "存储兼容性 Skill",
          publisher: "Hoox",
          version: "1.0.0",
          description: "对象存储兼容性验证",
          compatibility: "runtime >= 1",
          sourceUrl: "https://example.invalid/skill",
          sourceRevision: randomUUID(),
          licenseSpdx: "Apache-2.0",
        },
        files: [
          {
            path: "SKILL.md",
            mediaType: "text/markdown",
            contentBase64: Buffer.from(`# 测试\n${randomUUID()}\n`).toString("base64"),
          },
          {
            path: "资料.txt",
            mediaType: "text/plain",
            contentBase64: Buffer.from(
              `${"兼容性测试资料\n".repeat(32_768)}${randomUUID()}`,
            ).toString("base64"),
          },
        ],
      });
      const publications = await settleAll([
        publisher.publishPackage(publication),
        publisher.publishPackage(publication),
      ]);
      const first = defined(publications[0]);
      const second = defined(publications[1]);
      expect(first).toEqual(second);
      expect(race.conflicts()).toBeGreaterThanOrEqual(1);
      expect(await publisher.publishPackage(publication)).toEqual(first);
      for (const file of first.files) {
        const input = defined(publication.files.find((entry) => entry.path === file.path));
        equalBytes(
          await publisher.read({
            blobRef: file.blobRef,
            expectedDigest: file.contentDigest,
            expectedSizeBytes: file.sizeBytes,
          }),
          input.body,
        );
      }
      equalBytes(
        await publisher.read({
          blobRef: first.packageBlobRef,
          expectedDigest: publication.packageDigest,
          expectedSizeBytes: publication.packageManifest.byteLength,
        }),
        publication.packageManifest,
      );
    } finally {
      race.remove();
      publisher.close();
    }
  });

  conformance(
    "Worker 从真实 Blob 物化多个资源（含零字节文件），大文件按默认 4 MiB 分块并合并",
    async () => {
      const bodies = [
        Buffer.from("中文资源内容\n"),
        Buffer.from("second resource"),
        Buffer.alloc(0),
        largeBody,
      ];
      const files = await resourceFiles(bodies);
      const writes = new Map<string, Uint8Array>();
      let partCount = 0;
      const sandbox: SandboxHandle = {
        id: "storage-conformance-sandbox",
        command: async (command) => {
          const merge = command.split("\n").find((line) => line.startsWith("cat "));
          if (merge !== undefined) {
            const paths = [...merge.matchAll(/'([^']*)'/gu)].map((match) => defined(match[1]));
            const destination = defined(paths.pop());
            expect(paths).toHaveLength(3);
            const assembled = paths.map((path) => {
              const part = writes.get(path);
              expect(part).toBeDefined();
              return defined(part);
            });
            writes.set(destination, Buffer.concat(assembled));
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        writeFile: async (path, body) => {
          if (path.includes(".hooxpart-")) partCount += 1;
          writes.set(path, typeof body === "string" ? Buffer.from(body) : body.slice());
        },
        readFile: async () => "",
        runCode: async () => ({ stdout: [], stderr: [] }),
        pause: async () => undefined,
        kill: async () => undefined,
      };
      const materializer = new ManagedResourceFilesystemSnapshotMaterializer({
        resources: catalogFor(files),
        blobs,
        history: {
          listRecentDirectories: async () => [],
          listThreadIds: async () => [],
          resolveDirectory: async () => undefined,
          listThreadFiles: async () => [],
          resolveHistoryFile: async () => undefined,
          resolveThreadFile: async () => undefined,
        },
        skills: { listDirectory: async () => [], resolveFile: async () => undefined },
        skillContents: { read: unusedPromotion },
      });
      await materializer.materialize({
        scope: {
          ...scope,
          threadId: "thread-conformance",
          runId: "run-conformance",
          rootRunId: "run-conformance",
          workspaceId: "workspace-conformance",
        } as ExecutionScope,
        sandbox,
        signal: AbortSignal.timeout(90_000),
      });
      expect(partCount).toBe(3);
      files.forEach((file, index) => {
        const suffix = file.path.slice("/resources".length);
        const entry = [...writes].find(([path]) => path.endsWith(suffix));
        expect(entry).toBeDefined();
        equalBytes(defined(entry)[1], defined(bodies[index]));
      });
    },
  );

  conformance("API WebDAV 真实 HTTP PROPFIND、GET、HEAD、Range 与未授权拒绝", async () => {
    const bodies = [Buffer.from("HTTP 中文资源\n"), Buffer.alloc(0), largeBody];
    const files = await resourceFiles(bodies);
    const createFastify = createRequire(
      new URL("../../runtime-ts/apps/api/package.json", import.meta.url),
    )("fastify") as () => Parameters<typeof registerResourceFilesystemHttp>[0];
    const app = createFastify();
    const capabilities = createResourceFilesystemCapabilityCodec({
      secret: randomBytes(32).toString("hex"),
    });
    registerResourceFilesystemHttp(app, { catalog: catalogFor(files), blobs, capabilities });
    app.setErrorHandler((error, _request, reply) => {
      const status = (error as { readonly statusCode?: number }).statusCode;
      void reply.code(status === 401 ? 401 : 500).send();
    });
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      const headers = { authorization: `Bearer ${capabilities.issueHostVolume(scope)}` };
      const root = `${address}/v1/resource-filesystem`;
      const listing = await fetch(`${root}/`, {
        method: "PROPFIND",
        headers: { ...headers, depth: "1" },
        body: Buffer.from('<?xml version="1.0"?><propfind xmlns="DAV:"><allprop/></propfind>'),
      });
      expect(listing.status).toBe(207);
      const xml = await listing.text();
      expect(xml).not.toContain(prefix);
      for (const file of files) {
        expect(xml).toContain(file.resourceId);
        const directory = `${root}/${file.resourceId}/${file.versionId}`;
        const properties = await fetch(directory, {
          method: "PROPFIND",
          headers: { ...headers, depth: "1" },
        });
        expect(properties.status).toBe(207);
        expect(await properties.text()).toContain(encodeURIComponent(file.name));
        const url = `${directory}/${encodeURIComponent(file.name)}`;
        const response = await fetch(url, { headers });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-length")).toBe(String(file.sizeBytes));
        equalBytes(
          new Uint8Array(await response.arrayBuffer()),
          defined(bodies[files.indexOf(file)]),
        );
        const head = await fetch(url, { method: "HEAD", headers });
        expect(head.status).toBe(200);
        expect(head.headers.get("content-length")).toBe(String(file.sizeBytes));
        expect((await fetch(url)).status).toBe(401);
        if (file.sizeBytes > 0) {
          const range = await fetch(url, { headers: { ...headers, range: "bytes=1-3" } });
          expect(range.status).toBe(206);
          expect(range.headers.get("content-range")).toBe(`bytes 1-3/${file.sizeBytes}`);
          equalBytes(
            new Uint8Array(await range.arrayBuffer()),
            defined(bodies[files.indexOf(file)]).subarray(1, 4),
          );
        }
      }
    } finally {
      await app.close();
    }
  });
});

function conformance(name: string, run: () => Promise<void>): void {
  it(name, () => safely(run), 120_000);
}

async function safely(run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error && error.name === "AssertionError") throw error;
    const provider = error instanceof BlobStoreError ? error.cause : error;
    const status = (provider as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    const category = error instanceof BlobStoreError ? error.code : "PROVIDER_OR_TRANSPORT_ERROR";
    throw new Error(
      `对象存储操作失败（${category}，HTTP ${status ?? "未知"}；原始错误已隐藏，避免暴露凭据或签名 URL）`,
    );
  }
}

function trackClient(client: S3Client, skillPrefix = false): void {
  clients.add(client);
  client.middlewareStack.add(
    (next) => async (args) => {
      const input = args.input as { Key?: string };
      if (input.Key !== undefined) {
        const key = skillPrefix ? `${prefix}/skills/${input.Key}` : input.Key;
        if (!key.startsWith(`${prefix}/`)) throw new Error("测试禁止访问随机前缀外的对象");
        keys.add(key);
        return next({ ...args, input: { ...args.input, Key: key } });
      }
      return next(args);
    },
    { step: "initialize", name: "conformanceNamespace", priority: "high" },
  );
}

function missingHeadBarrier(client: S3Client, matches: (key: string) => boolean) {
  let heads = 0;
  let conflicts = 0;
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  client.middlewareStack.add(
    (next, context) => async (args) => {
      try {
        return await next(args);
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (context.commandName === "PutObjectCommand" && isS3ObjectAlreadyExists(error))
          conflicts += 1;
        if (
          context.commandName === "HeadObjectCommand" &&
          status === 404 &&
          heads < 2 &&
          matches((args.input as { Key: string }).Key)
        ) {
          heads += 1;
          if (heads === 2) release();
          await Promise.race([barrier, setTimeout(30_000, undefined, { ref: false })]);
        }
        throw error;
      }
    },
    { step: "initialize", name: "conformanceHeadBarrier" },
  );
  return {
    conflicts: () => conflicts,
    remove: () => {
      release();
      client.middlewareStack.remove("conformanceHeadBarrier");
    },
  };
}

async function stableResource(
  body: Uint8Array,
  mediaType = "application/octet-stream",
): Promise<StableBlobRef & { readonly purpose: "resource" }> {
  const descriptor = descriptorFor(body, mediaType);
  const incarnationId = randomUUID();
  const key = `${prefix}/stable/${scope.tenantId}/resource/sha256/${descriptor.sha256}/incarnations/${incarnationId}`;
  await objects.put({ key, body, descriptor });
  return {
    kind: "stable",
    ...scope,
    purpose: "resource",
    ...descriptor,
    incarnationId,
    physicalObjectKey: key,
  };
}

async function resourceFiles(bodies: readonly Uint8Array[]): Promise<ResourceFilesystemFile[]> {
  return Promise.all(
    bodies.map(async (body, index) => {
      const object = await stableResource(body);
      const id = resourceId(`resource-${randomUUID()}`);
      const version = resourceVersionId(`version-${randomUUID()}`);
      const name = `资源 ${index}+%.bin`;
      return {
        resourceId: id,
        versionId: version,
        name,
        path: `/resources/${id}/${version}/${name}`,
        mediaType: object.mediaType,
        sizeBytes: object.size,
        object,
      };
    }),
  );
}

function catalogFor(files: readonly ResourceFilesystemFile[]): ResourceFilesystemCatalog {
  return {
    list: async () => files,
    resolve: async (input) =>
      files.find(
        (file) => file.resourceId === input.resourceId && file.versionId === input.versionId,
      ),
  };
}

async function download(url: string): Promise<Response> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  expect(response.status).toBe(200);
  return response;
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function* bodyChunks(body: Uint8Array): Iterable<Uint8Array> {
  for (let offset = 0; offset < body.byteLength; offset += 64 * 1024)
    yield body.subarray(offset, offset + 64 * 1024);
}

function hash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function equalBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(hash(actual)).toBe(hash(expected));
}

async function unusedPromotion(): Promise<never> {
  throw new Error("对象存储兼容性套件不调用 PostgreSQL promotion 或未配置的内容端口");
}

async function blobFailure(run: () => Promise<unknown>) {
  try {
    await run();
    return { code: "NO_FAILURE" };
  } catch (error) {
    return blobErrorSemantics(error);
  }
}

function blobErrorSemantics(error: unknown) {
  if (!(error instanceof BlobStoreError)) throw error;
  return { code: error.code, result: error.result };
}

function defined<Value>(value: Value | undefined): Value {
  if (value === undefined) throw new Error("兼容性测试夹具缺少必要值");
  return value;
}

async function settleAll<Value>(tasks: readonly Promise<Value>[]): Promise<Value[]> {
  const results = await Promise.allSettled(tasks);
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}
