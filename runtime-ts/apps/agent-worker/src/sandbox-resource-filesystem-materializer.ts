import { createHash, randomUUID } from "node:crypto";
import type { TenantId } from "@hoox/domain";
import type { BlobStore, StableBlobRef } from "@hoox/persistence/blob";
import type {
  HistoryFilesystemCatalog,
  ResourceFilesystemCatalog,
  ResourceFilesystemFile,
} from "@hoox/resource";
import type { ExecutionScope } from "@hoox/run-contracts";
import type { SandboxHandle } from "@hoox/sandbox";
import type { SkillContentStore, SkillFilesystemCatalog } from "@hoox/skill";

const RESOURCE_ROOT = "/resources";
const DEFAULT_MAX_FILES = 512;
const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_MAX_SINGLE_FILE_BYTES = 32 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
// 部署主机到供应商数据面的链路差异很大：实测出现小请求持续成功、大请求体被静默丢弃并停满
// 超时的情况。只做大文件分块仍会卡在第一个大分块上，因此失败后按固定倍数缩小分块重试，
// 直到请求体足够小；每个分块独立重试，并用有界并发压缩总时长。
const DEFAULT_CHUNK_BYTES = 4 * 1024 * 1024;
const CHUNK_LEVEL_COUNT = 3;
const CHUNK_LEVEL_DIVISOR = 4;
const DEFAULT_WRITE_ATTEMPTS = 3;
const DEFAULT_WRITE_CONCURRENCY = 4;
const DEFAULT_WRITE_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_SKILL_DEPTH = 258;
const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Cs}]/u;

export interface SandboxResourceFilesystemMaterializerPort {
  materialize(input: {
    readonly scope: ExecutionScope;
    readonly sandbox: SandboxHandle;
    readonly signal: AbortSignal;
  }): Promise<void>;
}

interface SnapshotFile {
  readonly path: string;
  readonly body: Uint8Array;
  readonly digest: string;
}

interface SnapshotLimits {
  readonly maxFiles?: number;
  readonly maxTotalBytes?: number;
  readonly maxSingleFileBytes?: number;
  readonly commandTimeoutMs?: number;
  readonly chunkBytes?: number;
  readonly writeAttempts?: number;
  readonly writeConcurrency?: number;
  readonly writeAttemptTimeoutMs?: number;
}

interface ManagedResourceFilesystemDependencies {
  readonly resources: ResourceFilesystemCatalog;
  readonly history: HistoryFilesystemCatalog;
  readonly blobs: BlobStore;
  readonly skills: SkillFilesystemCatalog;
  readonly skillContents: SkillContentStore;
}

/**
 * E2B 没有部署侧 Cube Volume 时，由 Worker 在 Tenant RLS 内构造一次不可变来源快照，再通过
 * Provider 文件 API 写入 Sandbox。Sandbox 只得到业务字节，不得到 PostgreSQL、S3 或签名密钥；
 * 本地副本即使被 Sandbox 内 root 修改，也不会回写持久 Resource/Skill 来源。
 */
export class ManagedResourceFilesystemSnapshotMaterializer
  implements SandboxResourceFilesystemMaterializerPort
{
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxSingleFileBytes: number;
  private readonly commandTimeoutMs: number;
  private readonly chunkBytes: number;
  private readonly writeAttempts: number;
  private readonly writeConcurrency: number;
  private readonly writeAttemptTimeoutMs: number;

  constructor(
    private readonly dependencies: ManagedResourceFilesystemDependencies,
    limits: SnapshotLimits = {},
  ) {
    this.maxFiles = positiveLimit(limits.maxFiles, DEFAULT_MAX_FILES, "文件数量");
    this.maxTotalBytes = positiveLimit(limits.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "总字节数");
    this.maxSingleFileBytes = positiveLimit(
      limits.maxSingleFileBytes,
      DEFAULT_MAX_SINGLE_FILE_BYTES,
      "单文件字节数",
    );
    this.commandTimeoutMs = positiveLimit(
      limits.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      "命令超时",
    );
    this.chunkBytes = positiveLimit(limits.chunkBytes, DEFAULT_CHUNK_BYTES, "分块字节数");
    this.writeAttempts = positiveLimit(
      limits.writeAttempts,
      DEFAULT_WRITE_ATTEMPTS,
      "写入尝试次数",
    );
    this.writeConcurrency = positiveLimit(
      limits.writeConcurrency,
      DEFAULT_WRITE_CONCURRENCY,
      "写入并发度",
    );
    this.writeAttemptTimeoutMs = positiveLimit(
      limits.writeAttemptTimeoutMs,
      DEFAULT_WRITE_ATTEMPT_TIMEOUT_MS,
      "写入单次超时",
    );
  }

  async materialize(input: {
    readonly scope: ExecutionScope;
    readonly sandbox: SandboxHandle;
    readonly signal: AbortSignal;
  }): Promise<void> {
    assertNotAborted(input.signal);
    const snapshot = await this.buildSnapshot(input.scope, input.signal);
    const staging = `/tmp/hoox-resourcefs-${randomUUID()}`;
    const directories = snapshotDirectories(
      snapshot.files.map((file) => file.path),
      input.scope.threadId,
    );
    try {
      await input.sandbox.command(
        `set -eu\nrm -rf -- ${shellSingleQuote(staging)}\nmkdir -p -- ${shellSingleQuote(staging)}`,
        { signal: input.signal, timeoutMs: this.commandTimeoutMs },
      );
      await createDirectories(
        input.sandbox,
        staging,
        directories,
        input.signal,
        this.commandTimeoutMs,
      );
      await this.writeSnapshotFiles(input.sandbox, staging, snapshot.files, input.signal);
      await verifyFiles(
        input.sandbox,
        staging,
        snapshot.files,
        input.signal,
        this.commandTimeoutMs,
      );
      await input.sandbox.command(hardenAndSwapCommand(staging, input.scope.threadId), {
        signal: input.signal,
        timeoutMs: this.commandTimeoutMs,
      });
    } catch (error) {
      await input.sandbox
        .command(`rm -rf -- ${shellSingleQuote(staging)}`, {
          timeoutMs: Math.min(this.commandTimeoutMs, 10_000),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * 有界并发写出全部快照文件。任一次写入在重试后仍失败就让其余写入自然收尾，再抛出首个失败，
   * 避免清理 staging 之后仍有写入落回远端目录。
   */
  private async writeSnapshotFiles(
    sandbox: SandboxHandle,
    staging: string,
    files: readonly SnapshotFile[],
    signal: AbortSignal,
  ): Promise<void> {
    const pending = [...files];
    // 所有写入共享一个可下调的分块预算：任一文件在较小分块上成功后，其余文件直接复用。
    const budget = { bytes: this.chunkBytes };
    let failure: unknown;
    const worker = async () => {
      for (;;) {
        if (failure !== undefined) return;
        assertNotAborted(signal);
        const file = pending.shift();
        if (file === undefined) return;
        try {
          await this.writeSnapshotFile(
            sandbox,
            stagingPath(staging, file.path),
            file.body,
            signal,
            budget,
          );
        } catch (error) {
          failure ??= error;
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.writeConcurrency, pending.length) }, () => worker()),
    );
    if (failure !== undefined) throw failure;
  }

  /**
   * 先按当前分块预算写出；写不进去就换更小的分块重试同一文件。请求体越小越可能通过链路，
   * 而且每次失败只损失一个分块的等待时间。全部档位都失败才让整轮准备失败。
   */
  private async writeSnapshotFile(
    sandbox: SandboxHandle,
    path: string,
    body: Uint8Array,
    signal: AbortSignal,
    budget: { bytes: number },
  ): Promise<void> {
    let lastError: unknown;
    // 初值不能为 0：零字节文件的首档分块也是 0，否则会被当作重复档位全部跳过而误报写入失败。
    let previousPartBytes = -1;
    for (const level of chunkLevels(Math.min(budget.bytes, this.chunkBytes))) {
      const partBytes = Math.min(level, body.byteLength);
      // 降级后的档位仍然切出同样大小的请求体时跳过，避免重复一次注定相同的等待。
      if (partBytes === previousPartBytes) continue;
      previousPartBytes = partBytes;
      const writes = planChunkWrites(path, body, level);
      try {
        for (const write of writes)
          await this.writeChunkWithRetry(sandbox, write.path, write.body, signal);
        if (writes.length > 1) await this.mergeChunks(sandbox, path, writes, signal);
        budget.bytes = Math.min(budget.bytes, level);
        return;
      } catch (error) {
        lastError = error;
        await this.removeChunks(sandbox, writes);
      }
    }
    throw lastError ?? new Error("E2B ResourceFS 快照写入失败");
  }

  private async mergeChunks(
    sandbox: SandboxHandle,
    path: string,
    writes: readonly ChunkWrite[],
    signal: AbortSignal,
  ): Promise<void> {
    const quoted = writes.map((write) => shellSingleQuote(write.path));
    const assembled = await sandbox.command(
      `set -eu
cat ${quoted.join(" ")} > ${shellSingleQuote(path)}
rm -f ${quoted.join(" ")}`,
      { signal, timeoutMs: this.commandTimeoutMs },
    );
    if (assembled.exitCode !== 0) throw new Error("E2B ResourceFS 分块快照合并失败");
  }

  /** 失败档位留下的分块不能进入最终资源目录；清理是尽力而为，最终仍由 staging 兜底。 */
  private async removeChunks(sandbox: SandboxHandle, writes: readonly ChunkWrite[]): Promise<void> {
    const quoted = writes.map((write) => shellSingleQuote(write.path)).join(" ");
    await sandbox
      .command(`rm -f -- ${quoted}`, { timeoutMs: Math.min(this.commandTimeoutMs, 10_000) })
      .catch(() => undefined);
  }

  private async writeChunkWithRetry(
    sandbox: SandboxHandle,
    path: string,
    body: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const timeoutMs = Math.min(this.writeAttemptTimeoutMs, this.commandTimeoutMs);
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.writeAttempts; attempt += 1) {
      assertNotAborted(signal);
      try {
        await sandbox.writeFile(path, body, { signal, timeoutMs });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("E2B ResourceFS 快照写入失败");
  }

  private async buildSnapshot(
    scope: ExecutionScope,
    signal: AbortSignal,
  ): Promise<{ readonly files: readonly SnapshotFile[] }> {
    const files = new Map<string, SnapshotFile>();
    const resourceBytes = new Map<string, Promise<Uint8Array>>();
    let totalBytes = 0;
    const add = (file: SnapshotFile) => {
      assertSnapshotPath(file.path);
      if (file.body.byteLength > this.maxSingleFileBytes) {
        throw new Error("E2B ResourceFS 快照单文件超过上限");
      }
      if (sha256(file.body) !== file.digest) throw new Error("E2B ResourceFS 快照摘要不匹配");
      const existing = files.get(file.path);
      if (existing !== undefined) {
        if (existing.digest !== file.digest || existing.body.byteLength !== file.body.byteLength) {
          throw new Error("E2B ResourceFS 快照路径冲突");
        }
        return;
      }
      if (files.size >= this.maxFiles) throw new Error("E2B ResourceFS 快照文件数量超过上限");
      if (totalBytes + file.body.byteLength > this.maxTotalBytes) {
        throw new Error("E2B ResourceFS 快照总字节数超过上限");
      }
      files.set(file.path, Object.freeze(file));
      totalBytes += file.body.byteLength;
    };
    const resourceBody = (file: ResourceFilesystemFile) => {
      const key = `${file.object.sha256}:${file.object.size}:${file.object.incarnationId}`;
      let pending = resourceBytes.get(key);
      if (pending === undefined) {
        pending = this.dependencies.blobs.getBytes({ tenantId: scope.tenantId }, stableBlob(file));
        resourceBytes.set(key, pending);
      }
      return pending;
    };

    for (const file of await this.dependencies.resources.list({ tenantId: scope.tenantId })) {
      assertNotAborted(signal);
      add({ path: file.path, body: await resourceBody(file), digest: file.object.sha256 });
    }

    const recentDirectories = await this.dependencies.history.listRecentDirectories({
      tenantId: scope.tenantId,
    });
    if (recentDirectories !== undefined) {
      for (const directory of recentDirectories) {
        assertNotAborted(signal);
        const historyFiles = await this.dependencies.history.listThreadFiles({
          tenantId: scope.tenantId,
          threadId: directory.threadId,
        });
        for (const file of historyFiles ?? []) {
          add({
            path: `${RESOURCE_ROOT}/history/${directory.name}/${file.entryName}`,
            body: await resourceBody(file),
            digest: file.object.sha256,
          });
        }
      }
      const threadFiles = await this.dependencies.history.listThreadFiles({
        tenantId: scope.tenantId,
        threadId: scope.threadId,
      });
      for (const file of threadFiles ?? []) {
        add({
          path: `${RESOURCE_ROOT}/.thread-files/${scope.threadId}/files/${file.entryName}`,
          body: await resourceBody(file),
          digest: file.object.sha256,
        });
      }
    }

    await this.collectSkillDirectory(scope.tenantId, [], files, add, signal);
    return Object.freeze({
      files: Object.freeze(
        [...files.values()].sort((left, right) => left.path.localeCompare(right.path)),
      ),
    });
  }

  private async collectSkillDirectory(
    tenantId: TenantId,
    segments: readonly string[],
    files: ReadonlyMap<string, SnapshotFile>,
    add: (file: SnapshotFile) => void,
    signal: AbortSignal,
  ): Promise<void> {
    if (segments.length > MAX_SKILL_DEPTH) throw new Error("E2B Skill 快照目录深度超过上限");
    assertNotAborted(signal);
    const entries = await this.dependencies.skills.listDirectory({ tenantId, segments });
    if (entries === undefined) return;
    for (const entry of entries) {
      assertNotAborted(signal);
      const next = [...segments, entry.name];
      if (entry.kind === "directory") {
        await this.collectSkillDirectory(tenantId, next, files, add, signal);
        continue;
      }
      const path = `${RESOURCE_ROOT}/skills/${next.join("/")}`;
      if (files.has(path)) throw new Error("E2B Skill 快照路径冲突");
      const resolved = await this.dependencies.skills.resolveFile({ tenantId, segments: next });
      if (resolved === undefined) throw new Error("E2B Skill 快照文件在枚举后消失");
      const body =
        resolved.source.kind === "inline"
          ? new Uint8Array(resolved.source.body)
          : await this.dependencies.skillContents.read({
              blobRef: resolved.source.blobRef,
              expectedDigest: resolved.contentDigest,
              expectedSizeBytes: resolved.sizeBytes,
            });
      add({ path, body, digest: resolved.contentDigest });
    }
  }
}

function stableBlob(file: ResourceFilesystemFile): StableBlobRef {
  return Object.freeze({ kind: "stable" as const, ...file.object });
}

function snapshotDirectories(paths: readonly string[], threadId: string): readonly string[] {
  if (threadId.length === 0 || threadId.includes("/") || CONTROL_CHARACTER.test(threadId)) {
    throw new Error("E2B ResourceFS Thread ID 无效");
  }
  const directories = new Set<string>([
    RESOURCE_ROOT,
    `${RESOURCE_ROOT}/history`,
    `${RESOURCE_ROOT}/.thread-files`,
    `${RESOURCE_ROOT}/.thread-files/${threadId}`,
    `${RESOURCE_ROOT}/.thread-files/${threadId}/files`,
    `${RESOURCE_ROOT}/skills`,
  ]);
  for (const path of paths) {
    const segments = path.split("/").slice(1, -1);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      directories.add(current);
    }
  }
  return Object.freeze(
    [...directories].sort((left, right) => left.length - right.length || left.localeCompare(right)),
  );
}

async function createDirectories(
  sandbox: SandboxHandle,
  staging: string,
  directories: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  for (const chunk of chunks(directories, 48)) {
    assertNotAborted(signal);
    const targets = chunk.map((path) => shellSingleQuote(stagingPath(staging, path))).join(" ");
    await sandbox.command(`mkdir -p -- ${targets}`, { signal, timeoutMs });
  }
}

async function verifyFiles(
  sandbox: SandboxHandle,
  staging: string,
  files: readonly SnapshotFile[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  for (const chunk of chunks(files, 24)) {
    assertNotAborted(signal);
    const checks = chunk.map((file) => {
      const path = shellSingleQuote(stagingPath(staging, file.path));
      return `actual=$(sha256sum -- ${path} | cut -d ' ' -f 1); [ "$actual" = ${shellSingleQuote(file.digest)} ] || exit 78`;
    });
    const result = await sandbox.command(["set -eu", ...checks].join("\n"), { signal, timeoutMs });
    if (result.exitCode !== 0) throw new Error("E2B ResourceFS 快照远端摘要校验失败");
  }
}

function hardenAndSwapCommand(staging: string, threadId: string): string {
  const quotedStaging = shellSingleQuote(staging);
  const previous = `${staging}-previous`;
  const quotedPrevious = shellSingleQuote(previous);
  const historyTarget = `${RESOURCE_ROOT}/history`;
  const threadTarget = `${RESOURCE_ROOT}/.thread-files/${threadId}/files`;
  return `set -eu
sudo rm -rf -- ${quotedPrevious}
if [ -e ${shellSingleQuote(RESOURCE_ROOT)} ] || [ -L ${shellSingleQuote(RESOURCE_ROOT)} ]; then
  sudo mv -- ${shellSingleQuote(RESOURCE_ROOT)} ${quotedPrevious}
fi
sudo chown -R root:root -- ${quotedStaging}
sudo find ${quotedStaging} -type d -exec chmod 0555 {} +
sudo find ${quotedStaging} -type f -exec chmod 0444 {} +
sudo mv -- ${quotedStaging} ${shellSingleQuote(RESOURCE_ROOT)}
sudo rm -rf -- ${quotedPrevious}
ensure_root_link() {
  link="$1"
  target="$2"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] || exit 79
  elif [ -d "$link" ]; then
    [ -z "$(find "$link" -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 79
    sudo rmdir -- "$link"
    sudo ln -s -- "$target" "$link"
  elif [ -e "$link" ]; then
    exit 79
  else
    sudo ln -s -- "$target" "$link"
  fi
}
ensure_root_link /history ${shellSingleQuote(historyTarget)}
ensure_root_link /thread-files ${shellSingleQuote(threadTarget)}`;
}

interface ChunkWrite {
  readonly path: string;
  readonly body: Uint8Array;
}

/** 返回逐级缩小的候选分块大小；档位数量固定，保证单个文件最坏等待时间有上界。 */
function chunkLevels(start: number): readonly number[] {
  const levels: number[] = [];
  for (
    let size = Math.floor(start);
    size >= 1 && levels.length < CHUNK_LEVEL_COUNT;
    size = Math.floor(size / CHUNK_LEVEL_DIVISOR)
  )
    levels.push(size);
  return levels;
}

function planChunkWrites(
  path: string,
  body: Uint8Array,
  chunkBytes: number,
): readonly ChunkWrite[] {
  if (chunkBytes >= body.byteLength) return [{ path, body }];
  const writes: ChunkWrite[] = [];
  for (let offset = 0, index = 0; offset < body.byteLength; offset += chunkBytes, index += 1) {
    writes.push({
      path: `${path}.hooxpart-${index}`,
      body: body.subarray(offset, Math.min(offset + chunkBytes, body.byteLength)),
    });
  }
  return writes;
}

function stagingPath(staging: string, finalPath: string): string {
  if (finalPath === RESOURCE_ROOT) return staging;
  assertSnapshotPath(finalPath);
  return `${staging}${finalPath.slice(RESOURCE_ROOT.length)}`;
}

function assertSnapshotPath(path: string): void {
  if (
    !path.startsWith(`${RESOURCE_ROOT}/`) ||
    path.length > 4_096 ||
    Buffer.byteLength(path, "utf8") > 4_096 ||
    CONTROL_CHARACTER.test(path)
  ) {
    throw new Error("E2B ResourceFS 快照路径无效");
  }
  const segments = path.slice(1).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("E2B ResourceFS 快照路径无效");
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const actual = value ?? fallback;
  if (!Number.isSafeInteger(actual) || actual < 1)
    throw new TypeError(`E2B ResourceFS ${name}无效`);
  return actual;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("E2B ResourceFS 快照已取消");
}
