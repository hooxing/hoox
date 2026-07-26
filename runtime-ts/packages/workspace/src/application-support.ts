import { createHash } from "node:crypto";
import { WorkspaceApplicationError, WorkspaceDependencyError } from "./application-errors.js";
import type {
  WorkspaceExecutionPolicy,
  WorkspaceOperationIdentity,
  WorkspaceOperationJournalPort,
  WorkspaceUnknownFact,
} from "./application-ports.js";
import type { WorkspaceContentIdentity } from "./manifest.js";

const OPERATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

export function validateOperationKey(value: string): string {
  if (!OPERATION_KEY_PATTERN.test(value)) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "operationKey 格式无效");
  }
  return value;
}

export function validatePolicy(policy: WorkspaceExecutionPolicy): WorkspaceExecutionPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new WorkspaceApplicationError("INVALID_INPUT", `${name} 必须是正安全整数`);
    }
  }
  if (policy.maxSingleFileBytes > policy.maxTotalBytes) {
    throw new WorkspaceApplicationError("INVALID_INPUT", "单文件配额不能超过总配额");
  }
  return Object.freeze({ ...policy });
}

export function stopPoint(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceApplicationError("CANCELLED", "Workspace 操作已在安全停止点取消");
  }
}

export async function beginOperation(
  journal: WorkspaceOperationJournalPort,
  identity: WorkspaceOperationIdentity,
) {
  const state = await journal.begin(identity);
  if (state.status === "conflict") {
    throw new WorkspaceApplicationError("OPERATION_CONFLICT", "operationKey 已绑定其他输入");
  }
  if (state.status === "in_progress") {
    throw new WorkspaceApplicationError("OPERATION_IN_PROGRESS", "Workspace 操作正在执行");
  }
  if (state.status === "unknown") {
    throw new WorkspaceApplicationError("RESULT_UNKNOWN", "Workspace 操作等待外部结果对账");
  }
  return state;
}

export async function mapDependencyFailure(
  error: unknown,
  input: {
    readonly journal: WorkspaceOperationJournalPort;
    readonly identity: WorkspaceOperationIdentity;
    readonly phase: string;
    readonly now: () => Date;
  },
): Promise<never> {
  if (error instanceof WorkspaceApplicationError) throw error;
  const dependencyCode =
    error instanceof WorkspaceDependencyError
      ? safeDependencyCode(error.dependencyCode)
      : "UNCLASSIFIED";
  if (error instanceof WorkspaceDependencyError && error.result === "unknown") {
    const fact: WorkspaceUnknownFact = Object.freeze({
      operationKey: input.identity.operationKey,
      kind: input.identity.kind,
      phase: input.phase,
      dependencyCode,
      occurredAt: input.now().toISOString(),
    });
    await input.journal.recordUnknown(input.identity, fact);
    throw new WorkspaceApplicationError("RESULT_UNKNOWN", "外部副作用结果未知，已登记等待对账");
  }
  await input.journal.failKnown(input.identity, input.phase, dependencyCode);
  throw new WorkspaceApplicationError("DEPENDENCY_FAILED", "Workspace 外部依赖调用失败");
}

function safeDependencyCode(value: string): string {
  return /^[A-Z0-9_]{1,64}$/u.test(value) ? value : "UNCLASSIFIED";
}

export interface StreamVerification {
  readonly body: AsyncIterable<Uint8Array>;
  readonly result: Promise<WorkspaceContentIdentity>;
  readonly status: () => "pending" | "completed" | "failed";
}

/** 逐块校验并复制 chunk，调用方永远不会持有整个文件。result 仅在消费者读到 EOF 后完成。 */
export function verifyingStream(input: {
  readonly source: AsyncIterable<Uint8Array>;
  readonly policy: WorkspaceExecutionPolicy;
  readonly signal?: AbortSignal;
  readonly expected?: WorkspaceContentIdentity;
}): StreamVerification {
  let resolveResult: (value: WorkspaceContentIdentity) => void = () => undefined;
  let rejectResult: (reason: unknown) => void = () => undefined;
  let status: "pending" | "completed" | "failed" = "pending";
  const result = new Promise<WorkspaceContentIdentity>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // 防止端口在首块前抛错时产生未处理 rejection；调用方仍会 await 原 promise。
  void result.catch(() => undefined);
  const body = (async function* () {
    const hash = createHash("sha256");
    let size = 0;
    try {
      for await (const rawChunk of input.source) {
        stopPoint(input.signal);
        if (!(rawChunk instanceof Uint8Array)) {
          throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "文件流包含非法数据块");
        }
        if (rawChunk.byteLength > input.policy.maxChunkBytes) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "单个文件流数据块超过内存策略");
        }
        if (size > input.policy.maxSingleFileBytes - rawChunk.byteLength) {
          throw new WorkspaceApplicationError("LIMIT_EXCEEDED", "单文件超过 Workspace 配额");
        }
        const chunk = Uint8Array.from(rawChunk);
        size += chunk.byteLength;
        hash.update(chunk);
        yield chunk;
      }
      const identity = Object.freeze({ sha256: hash.digest("hex"), size });
      if (
        input.expected !== undefined &&
        (identity.sha256 !== input.expected.sha256 || identity.size !== input.expected.size)
      ) {
        throw new WorkspaceApplicationError("INTEGRITY_MISMATCH", "文件内容与声明身份不一致");
      }
      status = "completed";
      resolveResult(identity);
    } catch (error) {
      status = "failed";
      rejectResult(error);
      throw error;
    }
  })();
  return { body, result, status: () => status };
}

export async function digestStream(input: {
  readonly source: AsyncIterable<Uint8Array>;
  readonly policy: WorkspaceExecutionPolicy;
  readonly signal?: AbortSignal;
  readonly expected?: WorkspaceContentIdentity;
}): Promise<WorkspaceContentIdentity> {
  const verified = verifyingStream(input);
  for await (const _chunk of verified.body) {
    // 只做摘要和配额验证，不保留内容。
  }
  return verified.result;
}
