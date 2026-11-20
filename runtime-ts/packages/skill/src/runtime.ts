import { createHash } from "node:crypto";
import { skillFilesystemPackageRoot } from "./filesystem.js";

const invocationNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const canonicalKeyPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;
const maxArgumentsBytes = 16 * 1024;
const maxInstructionBytes = 64 * 1024;
const maxModelInstructionBytes = 512 * 1024;
const maxPackageFiles = 256;
const maxPackageBytes = 32 * 1024 * 1024;
const forbiddenDescriptionCharacters = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const forbiddenInvisibleDescriptionCodePoints = new Set([0x034f, 0x115f, 0x1160, 0x3164, 0xffa0]);

export interface RunSkillSnapshotItem {
  readonly source: "agent" | "tenant";
  readonly invocationName: string;
  readonly canonicalKey: string;
  readonly skillVersion: string;
  readonly description: string;
  readonly entrypointDigest: string;
  readonly packageDigest: string;
}

export interface ExplicitSkillInvocation {
  readonly invocationName: string;
  readonly args: string;
}

export function resolveExplicitSkillInvocation(input: {
  readonly inputText: string;
  readonly structured?: { readonly skill: string; readonly args?: string };
}): ExplicitSkillInvocation | undefined {
  const slash = /^\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})(?:\s+([\s\S]*))?$/u.exec(
    input.inputText.trim(),
  );
  if (slash !== null && input.structured !== undefined) {
    throw new SkillRuntimeError("SKILL_ARGUMENTS_INVALID");
  }
  if (input.structured !== undefined) {
    return Object.freeze({
      invocationName: validateInvocationName(input.structured.skill),
      args: validateArguments(input.structured.args ?? input.inputText),
    });
  }
  const invocationName = slash?.[1];
  if (invocationName === undefined) return undefined;
  return Object.freeze({
    invocationName: validateInvocationName(invocationName),
    args: validateArguments(slash?.[2] ?? ""),
  });
}

export interface RunSkillSnapshot {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly items: readonly RunSkillSnapshotItem[];
  readonly explicitInvocation?: ExplicitSkillInvocation;
}

export function digestRunSkillSnapshot(
  value: Pick<RunSkillSnapshot, "items" | "explicitInvocation">,
): string {
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      items: value.items.map((item) => ({
        invocationName: item.invocationName,
        canonicalKey: item.canonicalKey,
        skillVersion: item.skillVersion,
        description: item.description,
        entrypointDigest: item.entrypointDigest,
        packageDigest: item.packageDigest,
        // 历史快照只包含 Tenant 安装；保留其原有摘要，同时绑定 Agent 来源。
        ...(item.source === "agent" ? { source: item.source } : {}),
      })),
      explicit:
        value.explicitInvocation === undefined
          ? null
          : {
              invocationName: value.explicitInvocation.invocationName,
              argsDigest: sha256(value.explicitInvocation.args),
            },
    }),
  );
}

/** Worker 只把已经取得的双栅栏投影成此绑定；Skill 层不签发任何副作用许可。 */
export interface SkillExecutionBinding {
  readonly tenantId: string;
  readonly threadId: string;
  readonly runId: string;
  readonly rootRunId: string;
  readonly workspaceId: string;
  readonly baseRevisionId?: string;
  readonly attemptId: string;
  readonly runClaimToken: string;
  readonly runClaimEpoch: number;
  readonly workspaceLeaseRootRunId: string;
  readonly workspaceLeaseEpoch: number;
}

export interface SkillPackageFile {
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly contentDigest: string;
  /** 仅在受信后端端口之间传递，永不进入模型上下文。 */
  readonly blobRef: string;
}

export interface SkillInvocationTarget {
  readonly invocationId: string;
  readonly invocationName: string;
  readonly canonicalKey: string;
  readonly skillVersion: string;
  readonly entrypointDigest: string;
  readonly entrypointSizeBytes: number;
  readonly entrypointBlobRef: string;
  readonly packageDigest: string;
  readonly files: readonly SkillPackageFile[];
}

export type SkillInvocationFailureCode =
  | "SKILL_NOT_INSTALLED"
  | "SKILL_REVOKED"
  | "SKILL_INCOMPATIBLE"
  | "SKILL_CONTENT_UNAVAILABLE"
  | "SKILL_ARGUMENTS_INVALID"
  | "SKILL_CONTEXT_LIMIT"
  | "SKILL_PROTOCOL";

export class SkillRuntimeError extends Error {
  constructor(readonly code: SkillInvocationFailureCode) {
    super(code);
    this.name = "SkillRuntimeError";
  }
}

export interface SkillRuntimeRepository {
  beginInvocation(input: {
    readonly binding: SkillExecutionBinding;
    readonly source: "explicit" | "tool";
    readonly callId?: string;
    readonly invocationName: string;
    readonly argsDigest: string;
  }): Promise<SkillInvocationTarget>;
  completeInvocation(input: {
    readonly binding: SkillExecutionBinding;
    readonly invocationId: string;
    readonly instructionDigest: string;
    readonly status: "loaded" | "failed";
    readonly failureCode?: SkillInvocationFailureCode;
  }): Promise<void>;
  listLoadedPackages(input: {
    readonly binding: SkillExecutionBinding;
  }): Promise<readonly SkillInvocationTarget[]>;
}

export interface SkillContentStore {
  read(input: {
    readonly blobRef: string;
    readonly expectedDigest: string;
    readonly expectedSizeBytes: number;
  }): Promise<Uint8Array>;
}

export interface RuntimeSkillInstruction {
  readonly invocationId: string;
  readonly name: string;
  readonly version: string;
  readonly args: string;
  readonly digest: string;
  readonly instructions: string;
  readonly packageRoot: string;
  readonly resources: readonly Omit<SkillPackageFile, "blobRef">[];
  readonly modelText: string;
}

export class SkillRuntimeService {
  constructor(
    private readonly repository: SkillRuntimeRepository,
    private readonly contents: SkillContentStore,
  ) {}

  async loadInstruction(input: {
    readonly binding: SkillExecutionBinding;
    readonly source: "explicit" | "tool";
    readonly callId?: string;
    readonly invocationName: string;
    readonly args?: string;
  }): Promise<RuntimeSkillInstruction> {
    const invocationName = validateInvocationName(input.invocationName);
    const args = validateArguments(input.args ?? "");
    if (
      (input.source === "tool" && input.callId === undefined) ||
      (input.source === "explicit" && input.callId !== undefined)
    ) {
      throw new SkillRuntimeError("SKILL_PROTOCOL");
    }
    const argsDigest = sha256(args);
    let target: SkillInvocationTarget;
    try {
      target = await this.repository.beginInvocation({
        binding: input.binding,
        source: input.source,
        ...(input.callId === undefined ? {} : { callId: input.callId }),
        invocationName,
        argsDigest,
      });
    } catch (error) {
      if (error instanceof SkillRuntimeError) throw error;
      throw new SkillRuntimeError("SKILL_PROTOCOL");
    }

    let instruction: Omit<RuntimeSkillInstruction, "invocationId">;
    try {
      validateTarget(target);
      if (target.invocationName !== invocationName) {
        throw new SkillRuntimeError("SKILL_PROTOCOL");
      }
      const bytes = await this.contents.read({
        blobRef: target.entrypointBlobRef,
        expectedDigest: target.entrypointDigest,
        expectedSizeBytes: target.entrypointSizeBytes,
      });
      if (
        bytes.byteLength !== target.entrypointSizeBytes ||
        sha256Bytes(bytes) !== target.entrypointDigest
      ) {
        throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
      }
      const instructions = decodeUtf8(bytes);
      const packageRoot = skillFilesystemPackageRoot(target.canonicalKey, target.skillVersion);
      const digest = `sha256:${target.entrypointDigest}`;
      const resources = sortedPackageFiles(target.files)
        .filter((file) => file.path !== "SKILL.md")
        .map(({ blobRef: _blobRef, ...resource }) => Object.freeze(resource));
      const modelText = renderInstruction({
        name: invocationName,
        version: target.skillVersion,
        args,
        digest,
        instructions,
        packageRoot,
        resources,
      });
      if (Buffer.byteLength(modelText, "utf8") > maxModelInstructionBytes) {
        throw new SkillRuntimeError("SKILL_CONTEXT_LIMIT");
      }
      instruction = {
        name: invocationName,
        version: target.skillVersion,
        args,
        digest,
        instructions,
        packageRoot,
        resources,
        modelText,
      };
    } catch (error) {
      const failure =
        error instanceof SkillRuntimeError
          ? error
          : new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
      try {
        await this.repository.completeInvocation({
          binding: input.binding,
          invocationId: target.invocationId,
          instructionDigest: target.entrypointDigest,
          status: "failed",
          failureCode: failure.code,
        });
      } catch {
        throw new SkillRuntimeError("SKILL_PROTOCOL");
      }
      throw failure;
    }
    try {
      await this.repository.completeInvocation({
        binding: input.binding,
        invocationId: target.invocationId,
        instructionDigest: target.entrypointDigest,
        status: "loaded",
      });
    } catch {
      // loaded 提交结果未知时不能把调用降级成可重试的内容失败，必须停止模型 continuation。
      throw new SkillRuntimeError("SKILL_PROTOCOL");
    }
    return deepFreeze({ invocationId: target.invocationId, ...instruction });
  }

  /** waiting/重建 Session 从 durable invocation 恢复固定指令；原参数仍由历史 user turn 承载。 */
  async recoverLoadedInstructions(input: {
    readonly binding: SkillExecutionBinding;
  }): Promise<readonly RuntimeSkillInstruction[]> {
    const targets = await this.repository.listLoadedPackages(input);
    const recovered: RuntimeSkillInstruction[] = [];
    for (const target of targets) {
      validateTarget(target);
      const bytes = await this.contents.read({
        blobRef: target.entrypointBlobRef,
        expectedDigest: target.entrypointDigest,
        expectedSizeBytes: target.entrypointSizeBytes,
      });
      if (
        bytes.byteLength !== target.entrypointSizeBytes ||
        sha256Bytes(bytes) !== target.entrypointDigest
      ) {
        throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
      }
      const instructions = decodeUtf8(bytes);
      const packageRoot = skillFilesystemPackageRoot(target.canonicalKey, target.skillVersion);
      const digest = `sha256:${target.entrypointDigest}`;
      const resources = sortedPackageFiles(target.files)
        .filter((file) => file.path !== "SKILL.md")
        .map(({ blobRef: _blobRef, ...resource }) => Object.freeze(resource));
      const modelText = renderInstruction({
        name: target.invocationName,
        version: target.skillVersion,
        args: "",
        digest,
        instructions,
        packageRoot,
        resources,
      });
      if (Buffer.byteLength(modelText, "utf8") > maxModelInstructionBytes) {
        throw new SkillRuntimeError("SKILL_CONTEXT_LIMIT");
      }
      recovered.push(
        deepFreeze({
          invocationId: `recovered:${target.invocationName}`,
          name: target.invocationName,
          version: target.skillVersion,
          args: "",
          digest,
          instructions,
          packageRoot,
          resources,
          modelText,
        }),
      );
    }
    return Object.freeze(recovered);
  }
}

function renderInstruction(input: {
  readonly name: string;
  readonly version: string;
  readonly args: string;
  readonly digest: string;
  readonly instructions: string;
  readonly packageRoot: string;
  readonly resources: readonly Omit<SkillPackageFile, "blobRef">[];
}): string {
  const resources = input.resources.map((resource) => ({
    path: resource.path,
    mediaType: resource.mediaType,
    sizeBytes: resource.sizeBytes,
    digest: `sha256:${resource.contentDigest}`,
  }));
  return [
    `[RUNTIME_SKILL_INSTRUCTION schema=1 name=${JSON.stringify(input.name)} version=${JSON.stringify(input.version)} digest=${input.digest}]`,
    `args=${JSON.stringify(input.args)}`,
    "instructions:",
    input.instructions,
    `package_root=${input.packageRoot}`,
    `resources=${JSON.stringify(resources)}`,
    "[/RUNTIME_SKILL_INSTRUCTION]",
  ].join("\n");
}

function validateInvocationName(value: string): string {
  if (!invocationNamePattern.test(value)) {
    throw new SkillRuntimeError("SKILL_ARGUMENTS_INVALID");
  }
  return value;
}

function validateArguments(value: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxArgumentsBytes) {
    throw new SkillRuntimeError("SKILL_ARGUMENTS_INVALID");
  }
  return value;
}

function validateTarget(target: SkillInvocationTarget): void {
  if (
    !invocationNamePattern.test(target.invocationName) ||
    !canonicalKeyPattern.test(target.canonicalKey) ||
    !versionPattern.test(target.skillVersion) ||
    !digestPattern.test(target.entrypointDigest) ||
    !digestPattern.test(target.packageDigest) ||
    !Number.isSafeInteger(target.entrypointSizeBytes) ||
    target.entrypointSizeBytes < 1
  ) {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
  if (target.entrypointSizeBytes > maxInstructionBytes) {
    throw new SkillRuntimeError("SKILL_CONTEXT_LIMIT");
  }
  if (target.files.length < 1 || target.files.length > maxPackageFiles) {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  let entrypoint: SkillPackageFile | undefined;
  for (const file of target.files) {
    const segments = file.path.split("/");
    const foldedPath = file.path.toLocaleLowerCase("en-US");
    if (
      file.path.length === 0 ||
      file.path !== file.path.normalize("NFC") ||
      Buffer.byteLength(file.path, "utf8") > 1_024 ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      forbiddenDescriptionCharacters.test(file.path) ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
      paths.has(foldedPath) ||
      file.mediaType.trim().length < 3 ||
      file.mediaType.length > 255 ||
      forbiddenDescriptionCharacters.test(file.mediaType) ||
      !digestPattern.test(file.contentDigest) ||
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.blobRef.trim().length === 0 ||
      file.blobRef.length > 512
    ) {
      throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
    }
    paths.add(foldedPath);
    totalBytes += file.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxPackageBytes) {
      throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
    }
    if (file.path === "SKILL.md") entrypoint = file;
  }
  if (
    entrypoint === undefined ||
    entrypoint.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "text/markdown" ||
    entrypoint.sizeBytes !== target.entrypointSizeBytes ||
    entrypoint.contentDigest !== target.entrypointDigest
  ) {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
}

function sortedPackageFiles(files: readonly SkillPackageFile[]): SkillPackageFile[] {
  return [...files].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.length === 0) throw new Error("empty");
    return value;
  } catch {
    throw new SkillRuntimeError("SKILL_CONTENT_UNAVAILABLE");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertRunSkillSnapshot(value: RunSkillSnapshot): void {
  if (value.schemaVersion !== 1 || !digestPattern.test(value.digest) || value.items.length > 64) {
    throw new TypeError("Run Skill 快照无效");
  }
  let previous = "";
  for (const item of value.items) {
    if (
      (item.source !== "agent" && item.source !== "tenant") ||
      !invocationNamePattern.test(item.invocationName) ||
      item.invocationName <= previous ||
      !canonicalKeyPattern.test(item.canonicalKey) ||
      !versionPattern.test(item.skillVersion) ||
      !digestPattern.test(item.entrypointDigest) ||
      !digestPattern.test(item.packageDigest) ||
      item.description.length === 0 ||
      item.description !== item.description.normalize("NFC") ||
      hasForbiddenDescriptionCharacter(item.description) ||
      Buffer.byteLength(item.description, "utf8") > 2_048
    ) {
      throw new TypeError("Run Skill 快照条目无效");
    }
    previous = item.invocationName;
  }
  if (
    value.explicitInvocation !== undefined &&
    (!value.items.some(
      (item) => item.invocationName === value.explicitInvocation?.invocationName,
    ) ||
      Buffer.byteLength(value.explicitInvocation.args, "utf8") > maxArgumentsBytes)
  ) {
    throw new TypeError("显式 Skill 不在 Run 快照中");
  }
  if (value.digest !== digestRunSkillSnapshot(value)) {
    throw new TypeError("Run Skill 快照摘要不匹配");
  }
}

function hasForbiddenDescriptionCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      (character !== "\n" && forbiddenDescriptionCharacters.test(character)) ||
      (codePoint !== undefined &&
        (forbiddenInvisibleDescriptionCodePoints.has(codePoint) ||
          (codePoint >= 0xfe00 && codePoint <= 0xfe0d) ||
          (codePoint >= 0xe0100 && codePoint <= 0xe01ef)))
    ) {
      return true;
    }
  }
  return false;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
