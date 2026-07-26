import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { manifestError } from "./errors.js";
import { workspaceCaseCollisionKey, workspaceRelativePath } from "./path.js";

export const WORKSPACE_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface WorkspaceManifestPolicy {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxSingleFileBytes?: number;
  readonly maxPathUtf8Bytes?: number;
}

export interface WorkspaceContentIdentity {
  readonly sha256: string;
  readonly size: number;
}

/**
 * Stable 对象的完整生命周期身份。tenantId 和物理键属于身份事实，但不等于读取授权。
 */
export interface WorkspaceStableObjectIdentity {
  readonly tenantId: string;
  readonly purpose: "workspace";
  readonly incarnationId: string;
  readonly physicalObjectKey: string;
}

export interface WorkspaceFileEntry {
  readonly type: "file";
  readonly path: string;
  readonly content: WorkspaceContentIdentity;
  readonly object: WorkspaceStableObjectIdentity;
}

export interface WorkspaceManifest {
  readonly schemaVersion: typeof WORKSPACE_MANIFEST_SCHEMA_VERSION;
  readonly tenantId: string;
  readonly digest: string;
  readonly entries: readonly WorkspaceFileEntry[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const TENANT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const INCARNATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  manifestError(
    typeof value === "object" && value !== null && !Array.isArray(value),
    "INVALID_MANIFEST",
    `${label} 必须是对象`,
  );
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  manifestError(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    "INVALID_MANIFEST",
    `${label} 字段不符合 schemaVersion 1`,
  );
}

function safeLimit(value: number, name: string, allowZero: boolean): number {
  manifestError(
    Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0),
    "INVALID_MANIFEST",
    `${name} 必须是安全整数`,
  );
  return value;
}

function validatePolicy(policy: WorkspaceManifestPolicy): WorkspaceManifestPolicy {
  safeLimit(policy.maxFiles, "maxFiles", true);
  safeLimit(policy.maxTotalBytes, "maxTotalBytes", true);
  if (policy.maxSingleFileBytes !== undefined) {
    safeLimit(policy.maxSingleFileBytes, "maxSingleFileBytes", true);
  }
  if (policy.maxPathUtf8Bytes !== undefined) {
    safeLimit(policy.maxPathUtf8Bytes, "maxPathUtf8Bytes", false);
  }
  return policy;
}

function validatePhysicalObjectKey(
  key: unknown,
  content: WorkspaceContentIdentity,
  identity: Omit<WorkspaceStableObjectIdentity, "physicalObjectKey">,
): string {
  manifestError(typeof key === "string", "INVALID_OBJECT_IDENTITY", "物理对象键必须是字符串");
  const segments = key.split("/");
  manifestError(
    key.length > 0 &&
      key.length <= 1_024 &&
      !key.startsWith("/") &&
      !key.includes("\\") &&
      segments.every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          !Array.from(segment).some((character) => {
            const point = character.codePointAt(0);
            return point !== undefined && (point <= 31 || point === 127);
          }),
      ),
    "INVALID_OBJECT_IDENTITY",
    "物理对象键格式无效",
  );
  const suffix = `/stable/${identity.tenantId}/${identity.purpose}/sha256/${content.sha256}/incarnations/${identity.incarnationId}`;
  manifestError(
    key.endsWith(suffix),
    "INVALID_OBJECT_IDENTITY",
    "物理对象键与 Tenant、内容摘要或 incarnation 不一致",
  );
  return key;
}

function parseEntry(value: unknown): WorkspaceFileEntry {
  const input = record(value, "WorkspaceManifestEntry");
  assertExactKeys(input, ["type", "path", "content", "object"], "WorkspaceManifestEntry");
  manifestError(input.type === "file", "INVALID_MANIFEST", "首版只支持普通文件");
  const path = workspaceRelativePath(input.path);

  const contentInput = record(input.content, "WorkspaceContentIdentity");
  assertExactKeys(contentInput, ["sha256", "size"], "WorkspaceContentIdentity");
  manifestError(
    typeof contentInput.sha256 === "string" && SHA256_PATTERN.test(contentInput.sha256),
    "INVALID_MANIFEST",
    "文件内容摘要必须是小写 SHA-256",
  );
  manifestError(
    typeof contentInput.size === "number" &&
      Number.isSafeInteger(contentInput.size) &&
      contentInput.size >= 0,
    "INVALID_MANIFEST",
    "文件大小必须是非负安全整数",
  );
  const content = Object.freeze({ sha256: contentInput.sha256, size: contentInput.size });

  const objectInput = record(input.object, "WorkspaceStableObjectIdentity");
  assertExactKeys(
    objectInput,
    ["tenantId", "purpose", "incarnationId", "physicalObjectKey"],
    "WorkspaceStableObjectIdentity",
  );
  manifestError(
    typeof objectInput.tenantId === "string" && TENANT_ID_PATTERN.test(objectInput.tenantId),
    "INVALID_OBJECT_IDENTITY",
    "对象 Tenant ID 格式无效",
  );
  manifestError(
    objectInput.purpose === "workspace",
    "INVALID_OBJECT_IDENTITY",
    "对象用途必须是 workspace",
  );
  manifestError(
    typeof objectInput.incarnationId === "string" &&
      INCARNATION_ID_PATTERN.test(objectInput.incarnationId),
    "INVALID_OBJECT_IDENTITY",
    "对象 incarnationId 必须是小写 UUID v4",
  );
  const identityWithoutKey = {
    tenantId: objectInput.tenantId,
    purpose: objectInput.purpose,
    incarnationId: objectInput.incarnationId,
  } as const;
  const object = Object.freeze({
    ...identityWithoutKey,
    physicalObjectKey: validatePhysicalObjectKey(
      objectInput.physicalObjectKey,
      content,
      identityWithoutKey,
    ),
  });
  return Object.freeze({ type: "file", path, content, object });
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validateEntries(
  values: readonly unknown[],
  tenantId: string,
  policy?: WorkspaceManifestPolicy,
): readonly WorkspaceFileEntry[] {
  const checkedPolicy = policy === undefined ? undefined : validatePolicy(policy);
  if (checkedPolicy !== undefined) {
    manifestError(
      values.length <= checkedPolicy.maxFiles,
      "LIMIT_EXCEEDED",
      "文件数量超过调用方策略",
    );
  }

  const entries = Array.from(values, (value) => parseEntry(value)).sort((left, right) =>
    compareUtf8(left.path, right.path),
  );
  const exact = new Set<string>();
  const folded = new Map<string, string>();
  let totalBytes = 0;
  for (const entry of entries) {
    manifestError(
      entry.object.tenantId === tenantId,
      "TENANT_SCOPE_MISMATCH",
      "Workspace 文件对象不属于清单 Tenant",
    );
    manifestError(!exact.has(entry.path), "DUPLICATE_PATH", "Workspace 清单包含重复路径");
    exact.add(entry.path);
    const collisionKey = workspaceCaseCollisionKey(entry.path);
    const previous = folded.get(collisionKey);
    manifestError(
      previous === undefined || previous === entry.path,
      "DUPLICATE_PATH",
      "Workspace 清单包含大小写不敏感冲突",
    );
    folded.set(collisionKey, entry.path);

    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      manifestError(
        !exact.has(prefix) && !folded.has(workspaceCaseCollisionKey(prefix)),
        "PATH_CONFLICT",
        "Workspace 清单包含目录与文件冲突",
      );
    }
    if (checkedPolicy?.maxPathUtf8Bytes !== undefined) {
      manifestError(
        Buffer.byteLength(entry.path, "utf8") <= checkedPolicy.maxPathUtf8Bytes,
        "LIMIT_EXCEEDED",
        "文件路径超过调用方策略",
      );
    }
    if (checkedPolicy?.maxSingleFileBytes !== undefined) {
      manifestError(
        entry.content.size <= checkedPolicy.maxSingleFileBytes,
        "LIMIT_EXCEEDED",
        "单文件大小超过调用方策略",
      );
    }
    manifestError(
      totalBytes <= Number.MAX_SAFE_INTEGER - entry.content.size,
      "LIMIT_EXCEEDED",
      "文件总字节数超过安全整数范围",
    );
    totalBytes += entry.content.size;
  }
  if (checkedPolicy !== undefined) {
    manifestError(
      totalBytes <= checkedPolicy.maxTotalBytes,
      "LIMIT_EXCEEDED",
      "总字节数超过调用方策略",
    );
  }
  return Object.freeze(entries);
}

function canonicalEntry(entry: WorkspaceFileEntry): string {
  return `{"content":{"sha256":${JSON.stringify(entry.content.sha256)},"size":${entry.content.size}},"object":{"incarnationId":${JSON.stringify(entry.object.incarnationId)},"physicalObjectKey":${JSON.stringify(entry.object.physicalObjectKey)},"purpose":"workspace","tenantId":${JSON.stringify(entry.object.tenantId)}},"path":${JSON.stringify(entry.path)},"type":"file"}`;
}

/** schemaVersion 1 的 canonical bytes：固定字段序，entry 按 UTF-8 字节序排列。 */
function canonicalWorkspaceManifestBytes(
  tenantId: string,
  entries: readonly WorkspaceFileEntry[],
): Uint8Array {
  return Buffer.from(
    `{"entries":[${entries.map(canonicalEntry).join(",")}],"schemaVersion":1,"tenantId":${JSON.stringify(tenantId)}}`,
    "utf8",
  );
}

function digestWorkspaceManifestEntries(
  tenantId: string,
  entries: readonly WorkspaceFileEntry[],
): string {
  return createHash("sha256")
    .update(canonicalWorkspaceManifestBytes(tenantId, entries))
    .digest("hex");
}

/** 构造不可变、排序后的 WorkspaceManifest；产品配额必须由调用方显式传入。 */
export function createWorkspaceManifest(
  input: { readonly tenantId: string; readonly entries: readonly unknown[] },
  policy: WorkspaceManifestPolicy,
): WorkspaceManifest {
  manifestError(
    TENANT_ID_PATTERN.test(input.tenantId),
    "INVALID_MANIFEST",
    "清单 Tenant ID 格式无效",
  );
  manifestError(Array.isArray(input.entries), "INVALID_MANIFEST", "entries 必须是数组");
  const parsedEntries = validateEntries(input.entries, input.tenantId, policy);
  return Object.freeze({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    tenantId: input.tenantId,
    digest: digestWorkspaceManifestEntries(input.tenantId, parsedEntries),
    entries: parsedEntries,
  });
}

/** 在持久化或网络边界重新验证完整 schema、策略与 canonical digest。 */
export function parseWorkspaceManifest(
  value: unknown,
  expectedTenantId: string,
  policy: WorkspaceManifestPolicy,
): WorkspaceManifest {
  const input = record(value, "WorkspaceManifest");
  assertExactKeys(input, ["schemaVersion", "tenantId", "digest", "entries"], "WorkspaceManifest");
  manifestError(
    input.schemaVersion === WORKSPACE_MANIFEST_SCHEMA_VERSION,
    "INVALID_MANIFEST",
    "WorkspaceManifest schemaVersion 不受支持",
  );
  manifestError(
    Array.isArray(input.entries),
    "INVALID_MANIFEST",
    "WorkspaceManifest entries 必须是数组",
  );
  manifestError(
    typeof input.digest === "string" && SHA256_PATTERN.test(input.digest),
    "INVALID_MANIFEST",
    "WorkspaceManifest digest 格式无效",
  );
  manifestError(
    typeof input.tenantId === "string" && TENANT_ID_PATTERN.test(input.tenantId),
    "INVALID_MANIFEST",
    "清单 Tenant ID 格式无效",
  );
  manifestError(
    input.tenantId === expectedTenantId,
    "TENANT_SCOPE_MISMATCH",
    "WorkspaceManifest 不属于可信 Tenant",
  );
  const entries = validateEntries(input.entries, input.tenantId, policy);
  const digest = digestWorkspaceManifestEntries(input.tenantId, entries);
  manifestError(digest === input.digest, "INVALID_MANIFEST", "WorkspaceManifest digest 不匹配");
  return Object.freeze({
    schemaVersion: WORKSPACE_MANIFEST_SCHEMA_VERSION,
    tenantId: input.tenantId,
    digest,
    entries,
  });
}

/** 供纯函数规划器防御伪造类型；这里只验证完整性，不替上层决定产品配额。 */
export function assertWorkspaceManifestIntegrity(value: WorkspaceManifest): WorkspaceManifest {
  const input = record(value, "WorkspaceManifest");
  assertExactKeys(input, ["schemaVersion", "tenantId", "digest", "entries"], "WorkspaceManifest");
  manifestError(
    Array.isArray(input.entries),
    "INVALID_MANIFEST",
    "WorkspaceManifest entries 必须是数组",
  );
  manifestError(
    typeof input.tenantId === "string" && TENANT_ID_PATTERN.test(input.tenantId),
    "INVALID_MANIFEST",
    "清单 Tenant ID 格式无效",
  );
  const entries = validateEntries(input.entries, input.tenantId);
  manifestError(
    input.schemaVersion === 1,
    "INVALID_MANIFEST",
    "WorkspaceManifest schemaVersion 不受支持",
  );
  const digest = digestWorkspaceManifestEntries(input.tenantId, entries);
  manifestError(input.digest === digest, "INVALID_MANIFEST", "WorkspaceManifest digest 不匹配");
  return Object.freeze({ schemaVersion: 1, tenantId: input.tenantId, digest, entries });
}
