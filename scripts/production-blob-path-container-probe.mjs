import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createS3BlobStore, RUNTIME_BLOB_OBJECT_PREFIX } from "@cube-runtime/persistence";

const content = Buffer.from("production-artifact-container-gate", "utf8");
const digest = createHash("sha256").update(content).digest("hex");
const tenantId = "tenant_production_gate";
const incarnationId = "00000000-0000-4000-8000-000000000001";
const key = `${RUNTIME_BLOB_OBJECT_PREFIX}/stable/${tenantId}/artifact/sha256/${digest}/incarnations/${incarnationId}`;
const expectedPath = `/runtime-artifacts/${key}`;
const requests = [];

const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  requests.push(`${request.method ?? "UNKNOWN"} ${path}`);
  if (path !== expectedPath || (request.method !== "HEAD" && request.method !== "GET")) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-length", String(content.byteLength));
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.setHeader("x-amz-meta-sha256", digest);
  response.setHeader("etag", '"production-gate"');
  response.end(request.method === "GET" ? content : undefined);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("BLOB_GATE_LISTENER_INVALID");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const store = createS3BlobStore(
    {
      endpoint,
      publicEndpoint: endpoint,
      bucket: "runtime-artifacts",
      region: "us-east-1",
      accessKeyId: "container-gate",
      secretAccessKey: "container-gate-secret",
      forcePathStyle: true,
      prefix: RUNTIME_BLOB_OBJECT_PREFIX,
      maxPresignTtlSeconds: 60,
      maxBlobSizeBytes: 1024,
    },
    {},
  );
  const scope = { tenantId };
  const blob = {
    kind: "stable",
    tenantId,
    purpose: "artifact",
    sha256: digest,
    size: content.byteLength,
    mediaType: "text/plain; charset=utf-8",
    incarnationId,
    physicalObjectKey: key,
  };
  const head = await store.head(scope, blob);
  if (head?.blob.physicalObjectKey !== key) throw new Error("BLOB_GATE_HEAD_FAILED");
  const downloaded = await store.getBytes(scope, blob);
  if (!Buffer.from(downloaded).equals(content)) throw new Error("BLOB_GATE_DOWNLOAD_FAILED");
  const signed = new URL(
    await store.presignDownload({
      scope,
      blob,
      ttlSeconds: 60,
      responseMediaType: "text/plain; charset=utf-8",
      delivery: "artifact-download",
      downloadName: "artifact.txt",
    }),
  );
  if (
    signed.pathname !== expectedPath ||
    !signed.searchParams.has("X-Amz-Signature") ||
    signed.searchParams.get("response-content-disposition") !==
      "attachment; filename*=UTF-8''artifact.txt"
  ) {
    throw new Error("BLOB_GATE_PRESIGN_PATH_FAILED");
  }
  const headCount = requests.filter((request) => request === `HEAD ${expectedPath}`).length;
  if (headCount !== 2 || !requests.includes(`GET ${expectedPath}`)) {
    throw new Error("BLOB_GATE_REQUEST_PATH_FAILED");
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
