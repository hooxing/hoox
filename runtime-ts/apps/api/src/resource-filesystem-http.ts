import { createHash } from "node:crypto";
import { resourceId, resourceVersionId, type TenantId } from "@hoox/domain";
import type { BlobStore, StableBlobRef } from "@hoox/persistence";
import {
  HISTORY_FILESYSTEM_ROOT_SEGMENT,
  RESOURCE_FILESYSTEM_ROOT,
  THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT,
  type HistoryFilesystemCatalog,
  type HistoryFilesystemFile,
  type ResourceFilesystemCapabilityCodec,
  type ResourceFilesystemCatalog,
  type ResourceFilesystemFile,
} from "@hoox/resource";
import {
  assertSkillFilesystemEntry,
  assertSkillFilesystemFile,
  SKILL_FILESYSTEM_ROOT_SEGMENT,
  type SkillContentStore,
  type SkillFilesystemCatalog,
  type SkillFilesystemEntry,
} from "@hoox/skill";
import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from "fastify";

const HTTP_ROOT = "/v1/resource-filesystem";

interface ResourceFilesystemHttpDependencies {
  readonly catalog: ResourceFilesystemCatalog;
  readonly blobs: BlobStore;
  readonly capabilities: ResourceFilesystemCapabilityCodec;
  /**
   * TODO: 历史目录吞吐或故障域需要独立治理时，可拆为 ResourceFS 子模块/服务；
   * 对外继续保持同一 Tenant Volume 与 /history、/thread-files 路径契约。
   */
  readonly history?: HistoryFilesystemCatalog;
  readonly skills?: Readonly<{
    catalog: SkillFilesystemCatalog;
    contents: SkillContentStore;
  }>;
}

export function registerResourceFilesystemHttp(
  app: FastifyInstance,
  dependencies: ResourceFilesystemHttpDependencies,
): void {
  app.register((resourceApp, _options, done) => {
    resourceApp.addContentTypeParser(
      ["application/xml", "text/xml"],
      { parseAs: "string", bodyLimit: 64 * 1_024 },
      (_request, body, parserDone) => parserDone(null, body),
    );
    // rclone 的 PROPFIND 带 XML body 却不发送 Content-Type。兼容解析器只封装在只读
    // ResourceFS 路由内，避免放宽 JSON API 和文件上传端点的媒体类型契约。
    resourceApp.addContentTypeParser(
      "*",
      { parseAs: "string", bodyLimit: 64 * 1_024 },
      (_request, body, parserDone) => parserDone(null, body),
    );
    resourceApp.addHttpMethod("PROPFIND", { hasBody: true });
    for (const url of [HTTP_ROOT, `${HTTP_ROOT}/*`]) {
      resourceApp.route({
        method: "PROPFIND" as HTTPMethods,
        url,
        handler: async (request, reply) => handlePropfind(request, reply, dependencies),
      });
      resourceApp.route({
        method: ["GET", "HEAD", "OPTIONS"],
        url,
        handler: async (request, reply) => handleRead(request, reply, dependencies),
      });
    }
    done();
  });
}

async function handlePropfind(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ResourceFilesystemHttpDependencies,
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
  const segments = requestSegments(request.url);
  let target: FilesystemNode | undefined;
  let children: readonly FilesystemNode[] = [];
  if (segments.length === 0) {
    target = directoryNode([]);
    if (depth === "1") {
      const [files, history] = await Promise.all([
        dependencies.catalog.list({ tenantId: capability.tenantId }),
        dependencies.history?.listRecentDirectories({ tenantId: capability.tenantId }),
      ]);
      children = [
        ...resourceRootChildren(files),
        ...(dependencies.skills === undefined
          ? []
          : [directoryNode([SKILL_FILESYSTEM_ROOT_SEGMENT])]),
        ...(history === undefined
          ? []
          : [
              directoryNode([HISTORY_FILESYSTEM_ROOT_SEGMENT]),
              directoryNode([THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT]),
            ]),
      ].sort(compareNodes);
    }
  } else if (segments[0] === SKILL_FILESYSTEM_ROOT_SEGMENT) {
    const resolved = await resolveSkillNode(
      dependencies.skills?.catalog,
      capability.tenantId,
      segments,
      depth === "1",
    );
    target = resolved?.target;
    children = resolved?.children ?? [];
  } else if (segments[0] === HISTORY_FILESYSTEM_ROOT_SEGMENT) {
    const resolved = await resolveHistoryNode(
      dependencies.history,
      capability.tenantId,
      segments,
      depth === "1",
    );
    target = resolved?.target;
    children = resolved?.children ?? [];
  } else if (segments[0] === THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT) {
    const resolved = await resolveInternalThreadNode(
      dependencies.history,
      capability.tenantId,
      segments,
      depth === "1",
    );
    target = resolved?.target;
    children = resolved?.children ?? [];
  } else {
    const files = await dependencies.catalog.list({ tenantId: capability.tenantId });
    target = resolveResourceNode(files, segments);
    if (target !== undefined && depth === "1") children = resourceChildren(files, target);
  }
  if (target === undefined) {
    void reply.code(404).send();
    return;
  }
  const nodes = depth === "0" ? [target] : [target, ...children];
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
  dependencies: ResourceFilesystemHttpDependencies,
): Promise<void> {
  const capability = authorize(request, dependencies.capabilities);
  if (request.method === "OPTIONS") {
    void reply.code(204).header("allow", "OPTIONS, PROPFIND, GET, HEAD").header("dav", "1").send();
    return;
  }
  const segments = requestSegments(request.url);
  if (segments[0] === SKILL_FILESYSTEM_ROOT_SEGMENT) {
    await handleSkillRead(request, reply, dependencies.skills, capability.tenantId, segments);
    return;
  }
  if (
    segments[0] === HISTORY_FILESYSTEM_ROOT_SEGMENT ||
    segments[0] === THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT
  ) {
    await handleHistoryRead(request, reply, dependencies, capability.tenantId, segments);
    return;
  }
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
  await sendResourceFile(request, reply, dependencies.blobs, capability.tenantId, file);
}

async function handleHistoryRead(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ResourceFilesystemHttpDependencies,
  tenantId: TenantId,
  segments: readonly string[],
): Promise<void> {
  const history = dependencies.history;
  if (history === undefined) {
    void reply.code(404).send();
    return;
  }
  let file: HistoryFilesystemFile | undefined;
  if (
    segments[0] === HISTORY_FILESYSTEM_ROOT_SEGMENT &&
    segments.length === 4 &&
    segments[2] === "files"
  ) {
    file = await history.resolveHistoryFile({
      tenantId,
      directoryName: segments[1] ?? "",
      entryName: segments[3] ?? "",
    });
  } else if (
    segments[0] === THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT &&
    segments.length === 4 &&
    segments[2] === "files"
  ) {
    file = await history.resolveThreadFile({
      tenantId,
      threadId: segments[1] ?? "",
      entryName: segments[3] ?? "",
    });
  } else {
    const resolved =
      segments[0] === HISTORY_FILESYSTEM_ROOT_SEGMENT
        ? await resolveHistoryNode(history, tenantId, segments, false)
        : await resolveInternalThreadNode(history, tenantId, segments, false);
    void reply.code(resolved === undefined ? 404 : 405).send();
    return;
  }
  if (file === undefined) {
    void reply.code(404).send();
    return;
  }
  await sendResourceFile(request, reply, dependencies.blobs, tenantId, file);
}

async function sendResourceFile(
  request: FastifyRequest,
  reply: FastifyReply,
  blobs: BlobStore,
  tenantId: TenantId,
  file: ResourceFilesystemFile,
): Promise<void> {
  await sendFile(request, reply, fileMetadata(file), async () => {
    const bytes = await blobs.getBytes({ tenantId }, stableBlob(file));
    if (bytes.byteLength !== file.sizeBytes) throw new Error("Resource 文件内容大小不一致");
    return bytes;
  });
}
async function handleSkillRead(
  request: FastifyRequest,
  reply: FastifyReply,
  dependencies: ResourceFilesystemHttpDependencies["skills"],
  tenantId: TenantId,
  segments: readonly string[],
): Promise<void> {
  if (dependencies === undefined) {
    void reply.code(404).send();
    return;
  }
  const relativeSegments = segments.slice(1);
  const file = await dependencies.catalog.resolveFile({ tenantId, segments: relativeSegments });
  if (file === undefined) {
    const directory = await dependencies.catalog.listDirectory({
      tenantId,
      segments: relativeSegments,
    });
    void reply.code(directory === undefined ? 404 : 405).send();
    return;
  }
  assertSkillFilesystemFile(file);
  await sendFile(request, reply, file, async () => {
    const bytes =
      file.source.kind === "inline"
        ? file.source.body
        : await dependencies.contents.read({
            blobRef: file.source.blobRef,
            expectedDigest: file.contentDigest,
            expectedSizeBytes: file.sizeBytes,
          });
    if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== file.contentDigest) {
      throw new Error("Skill 文件内容完整性校验失败");
    }
    return bytes;
  });
}

async function sendFile(
  request: FastifyRequest,
  reply: FastifyReply,
  file: FilesystemFileMetadata,
  read: () => Promise<Uint8Array>,
): Promise<void> {
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
    .header("etag", `"${file.contentDigest}"`)
    .header("cache-control", "private, no-store")
    .header("x-content-type-options", "nosniff")
    .type(file.mediaType);
  if (range !== undefined)
    void reply.header("content-range", `bytes ${start}-${end}/${file.sizeBytes}`);
  if (request.method === "HEAD") {
    void reply.send();
    return;
  }
  const bytes = await read();
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

interface FilesystemFileMetadata {
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
}

type FilesystemNode =
  | { readonly kind: "directory"; readonly segments: readonly string[] }
  | {
      readonly kind: "file";
      readonly segments: readonly string[];
      readonly file: FilesystemFileMetadata;
    };

function directoryNode(segments: readonly string[]): FilesystemNode {
  return Object.freeze({ kind: "directory", segments: Object.freeze([...segments]) });
}

function fileNode(segments: readonly string[], file: FilesystemFileMetadata): FilesystemNode {
  return Object.freeze({ kind: "file", segments: Object.freeze([...segments]), file });
}

function resolveResourceNode(
  files: readonly ResourceFilesystemFile[],
  segments: readonly string[],
): FilesystemNode | undefined {
  if (segments.length === 1) {
    return files.some((file) => file.resourceId === segments[0])
      ? directoryNode([segments[0] ?? ""])
      : undefined;
  }
  if (segments.length === 2) {
    return files.some((file) => file.resourceId === segments[0] && file.versionId === segments[1])
      ? directoryNode([segments[0] ?? "", segments[1] ?? ""])
      : undefined;
  }
  if (segments.length === 3) {
    const file = files.find(
      (candidate) =>
        candidate.resourceId === segments[0] &&
        candidate.versionId === segments[1] &&
        candidate.path.split("/").at(-1) === segments[2],
    );
    return file === undefined ? undefined : fileNode(segments, fileMetadata(file));
  }
  return undefined;
}

function resourceRootChildren(files: readonly ResourceFilesystemFile[]): readonly FilesystemNode[] {
  return [...new Set(files.map((file) => String(file.resourceId)))].map((resource) =>
    directoryNode([resource]),
  );
}

function resourceChildren(
  files: readonly ResourceFilesystemFile[],
  node: FilesystemNode,
): readonly FilesystemNode[] {
  if (node.kind === "file") return [];
  if (node.segments.length === 1) {
    return [
      ...new Set(
        files
          .filter((file) => file.resourceId === node.segments[0])
          .map((file) => String(file.versionId)),
      ),
    ].map((version) => directoryNode([node.segments[0] ?? "", version]));
  }
  if (node.segments.length !== 2) return [];
  return files
    .filter((file) => file.resourceId === node.segments[0] && file.versionId === node.segments[1])
    .map((file) =>
      fileNode(
        [String(file.resourceId), String(file.versionId), file.path.split("/").at(-1) ?? "file"],
        fileMetadata(file),
      ),
    );
}

async function resolveHistoryNode(
  catalog: HistoryFilesystemCatalog | undefined,
  tenantId: TenantId,
  segments: readonly string[],
  includeChildren: boolean,
): Promise<
  { readonly target: FilesystemNode; readonly children: readonly FilesystemNode[] } | undefined
> {
  if (catalog === undefined || segments[0] !== HISTORY_FILESYSTEM_ROOT_SEGMENT) return undefined;
  if (segments.length === 1) {
    const directories = await catalog.listRecentDirectories({ tenantId });
    if (directories === undefined) return undefined;
    return {
      target: directoryNode(segments),
      children: includeChildren
        ? directories.map((directory) => directoryNode([...segments, directory.name]))
        : [],
    };
  }
  const directoryName = segments[1] ?? "";
  const directory = await catalog.resolveDirectory({ tenantId, directoryName });
  if (directory === undefined) return undefined;
  if (segments.length === 2) {
    return {
      target: directoryNode(segments),
      children: includeChildren ? [directoryNode([...segments, "files"])] : [],
    };
  }
  if (segments.length === 3 && segments[2] === "files") {
    const files = await catalog.listThreadFiles({ tenantId, threadId: directory.threadId });
    if (files === undefined) return undefined;
    return {
      target: directoryNode(segments),
      children: includeChildren
        ? files.map((file) => fileNode([...segments, file.entryName], fileMetadata(file)))
        : [],
    };
  }
  if (segments.length === 4 && segments[2] === "files") {
    const file = await catalog.resolveHistoryFile({
      tenantId,
      directoryName,
      entryName: segments[3] ?? "",
    });
    return file === undefined
      ? undefined
      : { target: fileNode(segments, fileMetadata(file)), children: [] };
  }
  return undefined;
}

async function resolveInternalThreadNode(
  catalog: HistoryFilesystemCatalog | undefined,
  tenantId: TenantId,
  segments: readonly string[],
  includeChildren: boolean,
): Promise<
  { readonly target: FilesystemNode; readonly children: readonly FilesystemNode[] } | undefined
> {
  if (catalog === undefined || segments[0] !== THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT) {
    return undefined;
  }
  // dot 根在普通 `ls` 中仍隐藏，但 WebDAV 必须枚举每一级父目录，rclone/FUSE 才能解析已知子路径。
  // 所有 personal Thread 都预声明稳定目录，首个附件只新增文件节点，不改变 rclone 已缓存的父目录拓扑。
  // Thread ID 不是授权边界；真正隔离仍由 Tenant capability 与 RLS 提供。
  if (segments.length === 1) {
    const threadIds = await catalog.listThreadIds({ tenantId });
    return threadIds === undefined
      ? undefined
      : {
          target: directoryNode(segments),
          children: includeChildren
            ? threadIds.map((threadId) => directoryNode([...segments, threadId]))
            : [],
        };
  }
  const threadId = segments[1] ?? "";
  const files = await catalog.listThreadFiles({ tenantId, threadId });
  if (files === undefined) return undefined;
  if (segments.length === 2) {
    return {
      target: directoryNode(segments),
      children: includeChildren ? [directoryNode([...segments, "files"])] : [],
    };
  }
  if (segments.length === 3 && segments[2] === "files") {
    return {
      target: directoryNode(segments),
      children: includeChildren
        ? files.map((file) => fileNode([...segments, file.entryName], fileMetadata(file)))
        : [],
    };
  }
  if (segments.length === 4 && segments[2] === "files") {
    const file = await catalog.resolveThreadFile({
      tenantId,
      threadId,
      entryName: segments[3] ?? "",
    });
    return file === undefined
      ? undefined
      : { target: fileNode(segments, fileMetadata(file)), children: [] };
  }
  return undefined;
}

async function resolveSkillNode(
  catalog: SkillFilesystemCatalog | undefined,
  tenantId: TenantId,
  segments: readonly string[],
  includeChildren: boolean,
): Promise<
  { readonly target: FilesystemNode; readonly children: readonly FilesystemNode[] } | undefined
> {
  if (catalog === undefined) return undefined;
  const relativeSegments = segments.slice(1);
  const file = await catalog.resolveFile({ tenantId, segments: relativeSegments });
  if (file !== undefined) {
    assertSkillFilesystemFile(file);
    return { target: fileNode(segments, file), children: [] };
  }
  const entries = await catalog.listDirectory({ tenantId, segments: relativeSegments });
  if (entries === undefined) return undefined;
  return {
    target: directoryNode(segments),
    children: includeChildren
      ? entries.map((entry) => skillEntryNode(segments, entry)).sort(compareNodes)
      : [],
  };
}

function skillEntryNode(parent: readonly string[], entry: SkillFilesystemEntry): FilesystemNode {
  assertSkillFilesystemEntry(entry);
  const segments = [...parent, entry.name];
  return entry.kind === "directory" ? directoryNode(segments) : fileNode(segments, entry);
}

function fileMetadata(file: ResourceFilesystemFile): FilesystemFileMetadata {
  return Object.freeze({
    mediaType: file.mediaType,
    sizeBytes: file.sizeBytes,
    contentDigest: file.object.sha256,
  });
}

function propfindResponse(node: FilesystemNode): string {
  const collection = node.kind === "directory";
  const suffix = node.segments.map(encodeURIComponent).join("/");
  const href = `${HTTP_ROOT}${suffix === "" ? "" : `/${suffix}`}${collection ? "/" : ""}`;
  const content =
    node.kind === "file"
      ? `<d:getcontentlength>${node.file.sizeBytes}</d:getcontentlength><d:getcontenttype>${escapeXml(node.file.mediaType)}</d:getcontenttype><d:getetag>&quot;${node.file.contentDigest}&quot;</d:getetag>`
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

function compareNodes(left: FilesystemNode, right: FilesystemNode): number {
  const leftName = left.segments.at(-1) ?? "";
  const rightName = right.segments.at(-1) ?? "";
  return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
