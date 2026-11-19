// Resource 文件系统数据面与历史入口的 Sandbox 探测；失败只产出脱敏类别，不泄漏路径或输出。
import type { SandboxHandle } from "@hoox/sandbox";
import type { UserInputAttachmentReference } from "./ports.js";

export const THREAD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export const ATTACHMENT_FACT_MARKERS = Object.freeze([
  "\n\n# 用户在本轮提供的文件\n",
  "\n\n# 用户在本轮上传的文件\n",
]);

export type ResourceFilesystemProbeResult =
  | { readonly outcome: "ready" }
  | { readonly outcome: "missing"; readonly category: string }
  | { readonly outcome: "failed"; readonly category: string };

export function directAttachmentProbePaths(
  input: string,
  attachments: readonly UserInputAttachmentReference[],
): readonly string[] {
  if (attachments.length === 0) return Object.freeze([]);
  const markerIndex = Math.max(
    ...ATTACHMENT_FACT_MARKERS.map((marker) => input.lastIndexOf(marker)),
  );
  // 老 Run 只有附件 ID、没有 API 追加的结构化路径事实；兼容读取，但不能猜测文件名。
  if (markerIndex < 0) return Object.freeze([]);
  const candidates: string[] = [];
  for (const line of input.slice(markerIndex).split("\n")) {
    if (!line.startsWith("- ")) continue;
    try {
      const fact: unknown = JSON.parse(line.slice(2));
      if (typeof fact !== "object" || fact === null || Array.isArray(fact)) continue;
      const path = (fact as Readonly<Record<string, unknown>>).文件地址;
      if (typeof path === "string") candidates.push(path);
    } catch {
      // marker 后的事实由 API 生成；解析失败最终会按缺失可信路径拒绝，而不是采用部分结果。
    }
  }
  const paths = attachments.map((attachment) => {
    const prefix = `/resources/${attachment.resourceId}/${attachment.versionId}/`;
    const matches = candidates.filter((path) => {
      if (!path.startsWith(prefix) || path.length > 1_024) return false;
      const fileName = path.slice(prefix.length);
      return (
        fileName.length > 0 && !fileName.includes("/") && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(fileName)
      );
    });
    if (matches.length !== 1) throw new Error("当前输入附件路径事实不完整");
    return matches[0] as string;
  });
  if (new Set(paths).size !== paths.length) throw new Error("当前输入附件路径事实重复");
  return Object.freeze(paths);
}

export async function probeResourceFilesystemDataPlane(
  sandbox: SandboxHandle,
  input: {
    readonly threadId: string;
    readonly historyFilesystemEnabled: boolean;
    readonly directAttachmentPaths: readonly string[];
    readonly signal: AbortSignal;
  },
): Promise<ResourceFilesystemProbeResult> {
  if (!THREAD_ID_PATTERN.test(input.threadId)) {
    return { outcome: "failed", category: "invalid_thread_id" };
  }
  const checks = ["[ -d '/resources' ] || exit 70"];
  if (input.historyFilesystemEnabled) {
    checks.push("[ -d '/resources/history' ] || exit 71");
    checks.push(
      `[ -d ${shellSingleQuote(`/resources/.thread-files/${input.threadId}/files`)} ] || exit 72`,
    );
  }
  for (const path of input.directAttachmentPaths) {
    checks.push(`[ -f ${shellSingleQuote(path)} ] || exit 75`);
  }
  let result: Awaited<ReturnType<SandboxHandle["command"]>>;
  try {
    result = await sandbox.command(["set -u", ...checks].join("\n"), {
      signal: input.signal,
      timeoutMs: 30_000,
    });
  } catch (error) {
    const category = historyEntrypointFailureCategory(error);
    console.warn(`RESOURCEFS_REUSE_PROBE_FAILED category=${category}`);
    return { outcome: "failed", category };
  }
  if (result.exitCode === 0) return { outcome: "ready" };
  const category = `exit_${result.exitCode}`;
  console.warn(`RESOURCEFS_REUSE_PROBE_FAILED category=${category}`);
  return [70, 71, 72, 75].includes(result.exitCode)
    ? { outcome: "missing", category }
    : { outcome: "failed", category };
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export async function prepareHistoryEntrypoints(
  sandbox: SandboxHandle,
  threadId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("历史目录 Thread ID 无效");
  const internalTarget = `/resources/.thread-files/${threadId}/files`;
  const command = `set -eu
history_target='/resources/history'
thread_target='${internalTarget}'
[ -d "$history_target" ] || exit 71
ensure_link() {
  link="$1"
  target="$2"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] || exit 73
  elif [ -e "$link" ]; then
    exit 74
  else
    ln -s "$target" "$link"
  fi
}
ensure_link /history "$history_target"
prepare_thread_entrypoint() {
  link='/thread-files'
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$thread_target" ] || exit 73
  elif [ -d "$link" ]; then
    [ -z "$(find "$link" -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 74
    rmdir "$link"
    ln -s "$thread_target" "$link"
  elif [ -e "$link" ]; then
    exit 74
  else
    ln -s "$thread_target" "$link"
  fi
}
prepare_thread_entrypoint`;
  const result = await sandbox.command(command, { signal, timeoutMs: 30_000 }).catch((error) => {
    console.warn(`HISTORY_ENTRYPOINT_FAILED category=${historyEntrypointFailureCategory(error)}`);
    throw error;
  });
  if (result.exitCode !== 0) {
    console.warn(`HISTORY_ENTRYPOINT_FAILED category=exit_${result.exitCode}`);
    throw new Error("历史目录固定入口准备失败");
  }
}

export function historyEntrypointFailureCategory(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "command_exception";
  }
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" && /^[A-Z_]{1,64}$/u.test(code)
    ? code.toLowerCase()
    : "command_exception";
}
