import { createHmac, timingSafeEqual } from "node:crypto";
import type { ResourceId, ResourceVersionId, TenantId } from "@cube-runtime/domain";
import type { ResourceCatalog, TrustedResourceContext } from "./contracts.js";
import { ResourceServiceError, resourceInvariant } from "./errors.js";

export const RESOURCE_FILESYSTEM_ROOT = "/resources" as const;
export const HISTORY_FILESYSTEM_ROOT_SEGMENT = "history" as const;
export const THREAD_FILESYSTEM_INTERNAL_ROOT_SEGMENT = ".thread-files" as const;
export const MAX_ATTACHMENTS_PER_INPUT = 20;

export interface ResourceAttachmentReference {
  readonly resourceId: ResourceId;
  readonly versionId: ResourceVersionId;
}

export interface ResourceAttachment {
  readonly resourceId: ResourceId;
  readonly versionId: ResourceVersionId;
  readonly name: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
}

export interface ResourceFilesystemStoredObject {
  readonly tenantId: string;
  readonly purpose: "resource";
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
  readonly incarnationId: string;
  readonly physicalObjectKey: string;
}

export interface ResourceFilesystemFile extends ResourceAttachment {
  readonly object: ResourceFilesystemStoredObject;
}

export interface HistoryFilesystemDirectory {
  readonly threadId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastFileAt: string;
  readonly fileCount: number;
}

export interface HistoryFilesystemFile extends ResourceFilesystemFile {
  readonly threadId: string;
  readonly directoryName: string;
  readonly entryName: string;
}

/**
 * 历史目录只通过路径定向查询读取，不能退化为加载 Tenant 全部 Resource 后在内存中过滤。
 * `undefined` 表示当前 Tenant 不具备个人历史目录能力，空数组表示能力存在但目录为空。
 */
export interface HistoryFilesystemCatalog {
  listRecentDirectories(input: {
    readonly tenantId: TenantId;
  }): Promise<readonly HistoryFilesystemDirectory[] | undefined>;
  listThreadIds(input: { readonly tenantId: TenantId }): Promise<readonly string[] | undefined>;
  resolveDirectory(input: {
    readonly tenantId: TenantId;
    readonly directoryName: string;
  }): Promise<HistoryFilesystemDirectory | undefined>;
  listThreadFiles(input: {
    readonly tenantId: TenantId;
    readonly threadId: string;
  }): Promise<readonly HistoryFilesystemFile[] | undefined>;
  resolveHistoryFile(input: {
    readonly tenantId: TenantId;
    readonly directoryName: string;
    readonly entryName: string;
  }): Promise<HistoryFilesystemFile | undefined>;
  resolveThreadFile(input: {
    readonly tenantId: TenantId;
    readonly threadId: string;
    readonly entryName: string;
  }): Promise<HistoryFilesystemFile | undefined>;
}

export interface ResourceFilesystemCatalog {
  list(input: { readonly tenantId: TenantId }): Promise<readonly ResourceFilesystemFile[]>;
  resolve(input: {
    readonly tenantId: TenantId;
    readonly resourceId: ResourceId;
    readonly versionId: ResourceVersionId;
  }): Promise<ResourceFilesystemFile | undefined>;
}

export interface ResourceAttachmentResolverPort {
  resolve(input: {
    readonly context: TrustedResourceContext;
    readonly attachments: readonly ResourceAttachmentReference[];
  }): Promise<readonly ResourceAttachment[]>;
}

export class ResourceAttachmentResolver implements ResourceAttachmentResolverPort {
  constructor(private readonly catalog: ResourceCatalog) {}

  async resolve(input: {
    readonly context: TrustedResourceContext;
    readonly attachments: readonly ResourceAttachmentReference[];
  }): Promise<readonly ResourceAttachment[]> {
    resourceInvariant(
      input.attachments.length <= MAX_ATTACHMENTS_PER_INPUT,
      "INVALID_REQUEST",
      `每条消息最多上传 ${MAX_ATTACHMENTS_PER_INPUT} 个文件`,
    );
    const seen = new Set<string>();
    const resolved: ResourceAttachment[] = [];
    for (const attachment of input.attachments) {
      const identity = `${attachment.resourceId}\0${attachment.versionId}`;
      resourceInvariant(!seen.has(identity), "INVALID_REQUEST", "消息附件不能重复");
      seen.add(identity);
      const found = await this.catalog.resolveVersion({
        context: input.context,
        resourceId: attachment.resourceId,
        versionId: attachment.versionId,
      });
      if (found.status === "not_found") {
        throw new ResourceServiceError("NOT_FOUND", "附件不存在或不属于当前用户");
      }
      resolved.push(
        Object.freeze({
          resourceId: found.resource.id,
          versionId: found.version.id,
          name: found.resource.name,
          path: resourceFilesystemPath(found.resource.id, found.version.id, found.resource.name),
          mediaType: found.version.mediaType,
          sizeBytes: found.version.sizeBytes,
        }),
      );
    }
    return Object.freeze(resolved);
  }
}

/**
 * 附件事实只追加到最新 user turn；调用方不得把返回文本拼入 system/developer prompt。
 * JSON 字符串化文件名，避免文件名中的换行或 Markdown 被误解释成额外指令。
 */
const attachmentFactMarker = "\n\n# 用户在本轮提供的文件\n";
const legacyAttachmentFactMarker = "\n\n# 用户在本轮上传的文件\n";

export function appendAttachmentsToLatestUserPrompt(
  prompt: string,
  attachments: readonly ResourceAttachment[],
): string {
  if (attachments.length === 0) return prompt;
  const facts = attachments.map((attachment) =>
    JSON.stringify({ 文件名: attachment.name, 文件地址: attachment.path }),
  );
  const prefix = prompt.trim().length === 0 ? "请处理本轮提供的文件。" : prompt;
  return `${prefix}${attachmentFactMarker}${facts.map((fact) => `- ${fact}`).join("\n")}`;
}

/** API 对话投影隐藏 Runtime 追加的附件事实，模型侧持久历史仍保留完整最新 user turn。 */
export function stripAttachmentsFromUserFacingPrompt(prompt: string): string {
  const index = Math.max(
    prompt.lastIndexOf(attachmentFactMarker),
    prompt.lastIndexOf(legacyAttachmentFactMarker),
  );
  return index < 0 ? prompt : prompt.slice(0, index);
}

export function resourceFilesystemPath(
  resourceId: ResourceId,
  versionId: ResourceVersionId,
  name: string,
): string {
  return `${RESOURCE_FILESYSTEM_ROOT}/${resourceId}/${versionId}/${resourceFilesystemFileName(name)}`;
}

export function resourceFilesystemFileName(name: string): string {
  const normalized = name.normalize("NFKC").trim();
  let safe = normalized
    .replace(/[\\/]/gu, "_")
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, "_")
    .replace(/[. ]+$/gu, "");
  if (safe === "" || safe === "." || safe === "..") safe = "file";
  const points = [...safe];
  while (Buffer.byteLength(points.join(""), "utf8") > 180) points.pop();
  const bounded = points.join("").replace(/[. ]+$/gu, "");
  return bounded.length === 0 ? "file" : bounded;
}

const historyTimestampFormatter = new Map<string, Intl.DateTimeFormat>();

export function historyFilesystemTimestamp(value: string | Date, timeZone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  resourceInvariant(!Number.isNaN(date.valueOf()), "INVALID_REQUEST", "历史文件时间无效");
  let formatter = historyTimestampFormatter.get(timeZone);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      });
    } catch {
      throw new ResourceServiceError("INVALID_REQUEST", "历史目录时区无效");
    }
    historyTimestampFormatter.set(timeZone, formatter);
  }
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const required = ["year", "month", "day", "hour", "minute", "second"] as const;
  resourceInvariant(
    required.every((part) => /^\d{2,4}$/u.test(values.get(part) ?? "")),
    "INVALID_REQUEST",
    "历史文件时间格式化失败",
  );
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}_${values.get("hour")}-${values.get("minute")}-${values.get("second")}`;
}

export function historyFilesystemDirectoryName(input: {
  readonly createdAt: string | Date;
  readonly title: string;
  readonly timeZone: string;
}): string {
  return `${historyFilesystemTimestamp(input.createdAt, input.timeZone)}_${resourceFilesystemFileName(input.title)}`;
}

export function historyFilesystemEntryName(input: {
  readonly attachedAt: string | Date;
  readonly name: string;
  readonly timeZone: string;
}): string {
  return `${historyFilesystemTimestamp(input.attachedAt, input.timeZone)}_${resourceFilesystemFileName(input.name)}`;
}

export function historyFilesystemCollisionName(baseName: string, ordinal: number): string {
  resourceInvariant(
    Number.isSafeInteger(ordinal) && ordinal >= 1,
    "INVALID_REQUEST",
    "历史目录冲突序号无效",
  );
  return ordinal === 1 ? baseName : `${baseName}-${ordinal}`;
}
export interface SandboxResourceFilesystemCapability {
  readonly tenantId: TenantId;
  readonly sandboxId: string;
  readonly expiresAt: number;
}

/** 只供 Cubelet 宿主机 Volume 插件持有；不会进入 Sandbox 或模型上下文。 */
export interface HostVolumeResourceFilesystemCapability {
  readonly kind: "host_volume";
  readonly tenantId: TenantId;
}

export type ResourceFilesystemCapability =
  | SandboxResourceFilesystemCapability
  | HostVolumeResourceFilesystemCapability;

export interface ResourceFilesystemCapabilityCodec {
  issue(input: {
    readonly tenantId: TenantId;
    readonly sandboxId: string;
    readonly ttlSeconds: number;
  }): string;
  issueHostVolume(input: { readonly tenantId: TenantId }): string;
  verify(token: string): ResourceFilesystemCapability | undefined;
}

interface CapabilityPayload {
  readonly v: 1;
  readonly tenantId: string;
  readonly sandboxId: string;
  readonly expiresAt: number;
}

interface HostVolumeCapabilityPayload {
  readonly v: 2;
  readonly tenantId: string;
}

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SANDBOX_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function createResourceFilesystemCapabilityCodec(input: {
  readonly secret: string | Uint8Array;
  readonly now?: () => number;
}): ResourceFilesystemCapabilityCodec {
  const secret =
    typeof input.secret === "string"
      ? new TextEncoder().encode(input.secret)
      : new Uint8Array(input.secret);
  resourceInvariant(
    secret.byteLength >= 32 && secret.byteLength <= 256,
    "INVALID_REQUEST",
    "Resource 文件系统签名密钥长度无效",
  );
  const now = input.now ?? Date.now;
  const sign = (body: string) => createHmac("sha256", secret).update(body).digest();
  const codec: ResourceFilesystemCapabilityCodec = {
    issue(request: {
      readonly tenantId: TenantId;
      readonly sandboxId: string;
      readonly ttlSeconds: number;
    }) {
      resourceInvariant(ID_PATTERN.test(request.tenantId), "INVALID_REQUEST", "Tenant ID 无效");
      resourceInvariant(
        SANDBOX_ID_PATTERN.test(request.sandboxId),
        "INVALID_REQUEST",
        "Sandbox ID 无效",
      );
      resourceInvariant(
        Number.isSafeInteger(request.ttlSeconds) &&
          request.ttlSeconds >= 1 &&
          request.ttlSeconds <= 86_400,
        "INVALID_REQUEST",
        "Resource 文件系统 capability TTL 无效",
      );
      const payload: CapabilityPayload = {
        v: 1,
        tenantId: request.tenantId,
        sandboxId: request.sandboxId,
        expiresAt: now() + request.ttlSeconds * 1_000,
      };
      const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${body}.${sign(body).toString("base64url")}`;
    },
    issueHostVolume(request: { readonly tenantId: TenantId }) {
      resourceInvariant(ID_PATTERN.test(request.tenantId), "INVALID_REQUEST", "Tenant ID 无效");
      const payload: HostVolumeCapabilityPayload = { v: 2, tenantId: request.tenantId };
      const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return `${body}.${sign(body).toString("base64url")}`;
    },
    verify(token: string) {
      if (token.length > 2_048 || !CAPABILITY_PATTERN.test(token)) return undefined;
      const [body, rawSignature] = token.split(".");
      if (body === undefined || rawSignature === undefined) return undefined;
      let signature: Buffer;
      let payload: unknown;
      try {
        signature = Buffer.from(rawSignature, "base64url");
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      } catch {
        return undefined;
      }
      const expected = sign(body);
      if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
        return undefined;
      }
      if (isCapabilityPayload(payload)) {
        if (payload.expiresAt <= now()) return undefined;
        return Object.freeze({
          tenantId: payload.tenantId as TenantId,
          sandboxId: payload.sandboxId,
          expiresAt: payload.expiresAt,
        });
      }
      if (!isHostVolumeCapabilityPayload(payload)) return undefined;
      return Object.freeze({
        kind: "host_volume" as const,
        tenantId: payload.tenantId as TenantId,
      });
    },
  };
  return Object.freeze(codec);
}

function isHostVolumeCapabilityPayload(value: unknown): value is HostVolumeCapabilityPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.v === 2 &&
    typeof record.tenantId === "string" &&
    ID_PATTERN.test(record.tenantId)
  );
}

function isCapabilityPayload(value: unknown): value is CapabilityPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.v === 1 &&
    typeof record.tenantId === "string" &&
    ID_PATTERN.test(record.tenantId) &&
    typeof record.sandboxId === "string" &&
    SANDBOX_ID_PATTERN.test(record.sandboxId) &&
    typeof record.expiresAt === "number" &&
    Number.isSafeInteger(record.expiresAt)
  );
}
