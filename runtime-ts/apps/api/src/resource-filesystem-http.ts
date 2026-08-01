import { resourceId, resourceVersionId } from "@cube-runtime/domain";
import type { BlobStore, StableBlobRef } from "@cube-runtime/persistence";
import {
  RESOURCE_FILESYSTEM_ROOT,
  type ResourceFilesystemCapabilityCodec,
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
} from "@cube-runtime/resource";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

const HTTP_ROOT = "/v1/resource-filesystem";

export function registerResourceFilesystemHttp(
  app: FastifyInstance,
  dependencies: Readonly<{
    catalog: ResourceFilesystemCatalog;
    blobs: BlobStore;
    capabilities: ResourceFilesystemCapabilityCodec;
  }>,
): void {
  app.addContentTypeParser(
    ["application/xml", "text/xml"],
    { parseAs: "string", bodyLimit: 64 * 1_024 },
    (_request, body, done) => done(null, body),
  );
  app.addHttpMethod("PROPFIND", { hasBody: true });
  for (const url of [HTTP_ROOT, `${HTTP_ROOT}/*`]) {
    app.route({
      method: "PROPFIND" as HTTPMethods,
      url,
      handler: async (request, reply) => handlePropfind(request, reply, dependencies),
    });
    app.route({
      method: ["GET", "HEAD", "OPTIONS"],
      url,
      handler: async (request, reply) => handleRead(request, reply, dependencies),
    });
  }
}

async function handlePropfind(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Readonly<{
    catalog: ResourceFilesystemCatalog;
    capabilities: ResourceFilesystemCapabilityCodec;
  }>,
): Promise<void> {
  const capability = authorize(request, dependencies.capabilities);
  const depth = request.headers.depth ?? "infinity";
  if (depth !== "0" && depth !== "1") {
    void reply
      .code(403)
      .type("application/xml; charset=utf-8")
      .send(
        '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:propfind-finite-depth/></d:error>',
      );
    return;
  }
  const files = await dependencies.catalog.list({ tenantId: capability.tenantId });
  const segments = requestSegments(request.url);
  const target = resolveNode(files, segments);
  if (target === undefined) {
    void reply.code(404).send();
    return;
  }
  const nodes = depth === "0" ? [target] : [target, ...childrenOf(files, target)];
  const xml = `<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">${nodes
    .map(propfindResponse)
    .join("")}</d:multistatus>`;
  void reply
    .code(207)
    .header("dav", "1")
    .header("cache-control", "private, no-store")
    .type("application/xml; charset=utf-8")
    .send(xml);
}

async function handleRead(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: Readonly<{
    catalog: ResourceFilesystemCatalog;
    blobs: BlobStore;
    capabilities: ResourceFilesystemCapabilityCodec;
  }>,
): Promise<void> {
  const capability = authorize(request, dependencies.capabilities);
  if (request.method === "OPTIONS") {
    void reply.code(204).header("allow", "OPTIONS, PROPFIND, GET, HEAD").header("dav", "1").send();
    return;
  }
  const segments = requestSegments(request.url);
  if (segments.length !== 3) {
    void reply.code(segments.length < 3 ? 405 : 404).send();
    return;
  }
  let resource: ReturnType<typeof resourceId>;
  let version: ReturnType<typeof resourceVersionId>;
  try {
    resource = resourceId(segments[0] ?? "");
    version = resourceVersionId(segments[1] ?? "");
  } catch {
    void reply.code(404).send();
    return;
  }
  const file = await dependencies.catalog.resolve({
    tenantId: capability.tenantId,
    resourceId: resource,
    versionId: version,
  });
  if (file === undefined || segments[2] !== file.path.split("/").at(-1)) {
    void reply.code(404).send();
    return;
  }
  const range = parseRange(request.headers.range, file.sizeBytes);
  if (range === "invalid") {
    void reply.code(416).header("content-range", `bytes */${file.sizeBytes}`).send();
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, file.sizeBytes - 1);
  const length = file.sizeBytes === 0 ? 0 : end - start + 1;
  void reply
    .code(range === undefined ? 200 : 206)
    .header("accept-ranges", "bytes")
    .header("content-length", String(length))
    .header("etag", `"${file.object.sha256}"`)
    .header("cache-control", "private, no-store")
    .header("x-content-type-options", "nosniff")
    .type(file.mediaType);
  if (range !== undefined)
    void reply.header("content-range", `bytes ${start}-${end}/${file.sizeBytes}`);
  if (request.method === "HEAD") {
    void reply.send();
    return;
  }
  const bytes = await dependencies.blobs.getBytes(
    { tenantId: capability.tenantId },
    stableBlob(file),
  );
  if (bytes.byteLength !== file.sizeBytes) throw new Error("Resource 文件内容大小不一致");
  void reply.send(Buffer.from(bytes.subarray(start, start + length)));
}

function authorize(request: FastifyRequest, codec: ResourceFilesystemCapabilityCodec) {
  const values: string[] = [];
  for (let index = 0; index + 1 < request.raw.rawHeaders.length; index += 2) {
    if (request.raw.rawHeaders[index]?.toLowerCase() === "authorization") {
      const value = request.raw.rawHeaders[index + 1];
      if (value !== undefined) values.push(value);
    }
  }
  if (values.length !== 1 || !values[0]?.startsWith("Bearer ")) {
    throw new ResourceFilesystemHttpError(401);
  }
  const capability = codec.verify(values[0].slice("Bearer ".length));
  if (capability === undefined) throw new ResourceFilesystemHttpError(401);
  return capability;
}

export class ResourceFilesystemHttpError extends Error {
  constructor(readonly statusCode: 401 | 404) {
    super("RESOURCE_FILESYSTEM_HTTP_ERROR");
    this.name = "ResourceFilesystemHttpError";
  }
}

type FilesystemNode =
  | { readonly kind: "root"; readonly segments: readonly [] }
  | { readonly kind: "resource"; readonly segments: readonly [string] }
  | { readonly kind: "version"; readonly segments: readonly [string, string] }
  | {
      readonly kind: "file";
      readonly segments: readonly [string, string, string];
      readonly file: ResourceFilesystemFile;
    };

function resolveNode(
  files: readonly ResourceFilesystemFile[],
  segments: readonly string[],
): FilesystemNode | undefined {
  if (segments.length === 0) return { kind: "root", segments: [] };
  if (segments.length === 1) {
    return files.some((file) => file.resourceId === segments[0])
      ? { kind: "resource", segments: [segments[0] ?? ""] }
      : undefined;
  }
  if (segments.length === 2) {
    return files.some((file) => file.resourceId === segments[0] && file.versionId === segments[1])
      ? { kind: "version", segments: [segments[0] ?? "", segments[1] ?? ""] }
      : undefined;
  }
  if (segments.length === 3) {
    const file = files.find(
      (candidate) =>
        candidate.resourceId === segments[0] &&
        candidate.versionId === segments[1] &&
        candidate.path.split("/").at(-1) === segments[2],
    );
    return file === undefined
      ? undefined
      : {
          kind: "file",
          segments: [segments[0] ?? "", segments[1] ?? "", segments[2] ?? ""],
          file,
        };
  }
  return undefined;
}

function childrenOf(
  files: readonly ResourceFilesystemFile[],
  node: FilesystemNode,
): readonly FilesystemNode[] {
  if (node.kind === "file") return [];
  if (node.kind === "root") {
    return [...new Set(files.map((file) => String(file.resourceId)))].map((resource) => ({
      kind: "resource" as const,
      segments: [resource] as const,
    }));
  }
  if (node.kind === "resource") {
    return [
      ...new Set(
        files
          .filter((file) => file.resourceId === node.segments[0])
          .map((file) => String(file.versionId)),
      ),
    ].map((version) => ({
      kind: "version" as const,
      segments: [node.segments[0], version] as const,
    }));
  }
  return files
    .filter((file) => file.resourceId === node.segments[0] && file.versionId === node.segments[1])
    .map((file) => ({
      kind: "file" as const,
      segments: [
        String(file.resourceId),
        String(file.versionId),
        file.path.split("/").at(-1) ?? "file",
      ] as const,
      file,
    }));
}

function propfindResponse(node: FilesystemNode): string {
  const collection = node.kind !== "file";
  const suffix = node.segments.map(encodeURIComponent).join("/");
  const href = `${HTTP_ROOT}${suffix === "" ? "" : `/${suffix}`}${collection ? "/" : ""}`;
  const content =
    node.kind === "file"
      ? `<d:getcontentlength>${node.file.sizeBytes}</d:getcontentlength><d:getcontenttype>${escapeXml(node.file.mediaType)}</d:getcontenttype><d:getetag>&quot;${node.file.object.sha256}&quot;</d:getetag>`
      : "<d:resourcetype><d:collection/></d:resourcetype>";
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop><d:displayname>${escapeXml(node.segments.at(-1) ?? RESOURCE_FILESYSTEM_ROOT)}</d:displayname>${content}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
}

function requestSegments(url: string): readonly string[] {
  const pathname = new URL(url, "http://resource-filesystem.invalid").pathname;
  if (pathname !== HTTP_ROOT && !pathname.startsWith(`${HTTP_ROOT}/`)) return [];
  const suffix = pathname.slice(HTTP_ROOT.length).replace(/^\/+|\/+$/gu, "");
  if (suffix === "") return [];
  try {
    return suffix.split("/").map((segment) => decodeURIComponent(segment));
  } catch {
    return ["__invalid_path__"];
  }
}

function stableBlob(file: ResourceFilesystemFile): StableBlobRef {
  return Object.freeze({ kind: "stable" as const, ...file.object });
}

function parseRange(
  value: string | undefined,
  size: number,
): { readonly start: number; readonly end: number } | "invalid" | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=([0-9]+)-([0-9]*)$/u.exec(value);
  if (match === null || size === 0) return "invalid";
  const start = Number(match[1]);
  const requestedEnd = match[2] === "" ? size - 1 : Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
