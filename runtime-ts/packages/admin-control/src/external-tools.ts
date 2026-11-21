import type {
  AdminExternalToolBatchDto,
  AdminExternalToolOverview,
  AdminHttpToolPreview,
  AdminHttpToolPreviewRequest,
  AdminMcpDraftDto,
  AdminMcpDraftSettings,
  AdminMcpProbeReport,
  AdminMcpProbeTool,
} from "@hoox/protocol";
import type { ControlOperatorRole } from "./index.js";

export type {
  AdminExternalToolBatchDto,
  AdminExternalToolOverview,
  AdminExternalToolVersionSummary,
  AdminHttpToolPreview,
  AdminHttpToolPreviewRequest,
  AdminMcpDraftDto,
  AdminMcpDraftSettings,
  AdminMcpProbeReport,
} from "@hoox/protocol";

/** 注册、凭据、探测、发布与撤销仅限 admin；operator 只能经 Agent 编辑页的受限视图选择。 */
export function externalToolAccess(role: ControlOperatorRole | undefined) {
  return {
    canRegister: role === "admin",
    canSelect: role === "operator" || role === "admin",
  } as const;
}

export type ExternalToolAdminErrorCode =
  | "NOT_AUTHORIZED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID"
  | "PUBLISH_REJECTED"
  | "PROBE_UNAVAILABLE";

/** 消息均为受控中文文案，可直接返回给后台；不得拼接凭据、Schema 或远端原文。 */
export class ExternalToolAdminError extends Error {
  readonly code: ExternalToolAdminErrorCode;
  constructor(code: ExternalToolAdminErrorCode, message: string) {
    super(message);
    this.name = "ExternalToolAdminError";
    this.code = code;
  }
}

export interface AcceptedMcpProbeTool {
  readonly remoteToolName: string;
  readonly modelToolName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly inputSchemaDigest: string;
}
export type McpProbeToolResult =
  | (AcceptedMcpProbeTool & { readonly accepted: true })
  | {
      readonly accepted: false;
      readonly remoteToolName?: string;
      readonly reason: string;
      readonly reasonMessage: string;
    };

export type McpProbePort = (input: {
  readonly endpoint: string;
  readonly serverName: string;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
  readonly credential?: string;
}) => Promise<readonly McpProbeToolResult[]>;

export type HttpToolPreviewPort = (input: AdminHttpToolPreviewRequest) => AdminHttpToolPreview;

export interface ExternalToolCommandContext {
  readonly actorUserId: string;
  readonly idempotencyKey: string;
}

export interface ExternalToolAdminRepositoryPort {
  requireAdmin(actorUserId: string): Promise<void>;
  overview(actorUserId: string): Promise<AdminExternalToolOverview>;
  createMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly settings: AdminMcpDraftSettings;
      readonly credential?: string;
    },
  ): Promise<AdminMcpDraftDto>;
  updateMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly settings: AdminMcpDraftSettings;
    },
  ): Promise<AdminMcpDraftDto>;
  setDraftCredential(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly credential: string | null;
    },
  ): Promise<AdminMcpDraftDto>;
  /** 读取当前草稿与解密后的凭据；仅供本进程内探测使用，调用方不得持久化或回显。 */
  loadDraftForProbe(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedGeneration: number;
  }): Promise<{ readonly draft: AdminMcpDraftDto; readonly credential?: string }>;
  replayPublish(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
    },
  ): Promise<AdminExternalToolBatchDto | undefined>;
  recordProbeAudit(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly action: "probed" | "published";
    readonly outcome: "succeeded" | "rejected" | "failed";
    readonly reason: string;
  }): Promise<void>;
  publishMcpBatch(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly tools: readonly AcceptedMcpProbeTool[];
    },
  ): Promise<AdminExternalToolBatchDto>;
  revokeBatch(
    input: ExternalToolCommandContext & { readonly batchId: string; readonly reason: string },
  ): Promise<AdminExternalToolBatchDto>;
}

export function validateMcpDraftSettings(settings: AdminMcpDraftSettings): AdminMcpDraftSettings {
  const displayName = settings.displayName.trim();
  if (!displayName || Buffer.byteLength(displayName, "utf8") > 200)
    throw new ExternalToolAdminError("INVALID", "Server 显示名称不能为空且不得超过 200 字节");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(settings.serverName))
    throw new ExternalToolAdminError(
      "INVALID",
      "Server 标识只能包含字母、数字、点、下划线和连字符，且以字母或数字开头",
    );
  let url: URL;
  try {
    url = new URL(settings.endpoint);
  } catch {
    throw new ExternalToolAdminError("INVALID", "Server 地址必须是有效的 HTTPS 地址");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    /[?#]/u.test(settings.endpoint) ||
    settings.endpoint.length > 2048 ||
    url.href.length > 2048
  )
    throw new ExternalToolAdminError(
      "INVALID",
      "Server 地址必须是 2048 字符以内的 HTTPS 地址，不得包含用户凭据、查询串或片段",
    );
  if (
    !Number.isInteger(settings.timeoutMs) ||
    settings.timeoutMs < 100 ||
    settings.timeoutMs > 120_000
  )
    throw new ExternalToolAdminError("INVALID", "超时时间必须在 100 到 120000 毫秒之间");
  if (
    !Number.isInteger(settings.maxResponseBytes) ||
    settings.maxResponseBytes < 1 ||
    settings.maxResponseBytes > 1_048_576
  )
    throw new ExternalToolAdminError("INVALID", "响应上限必须在 1 到 1048576 字节之间");
  return Object.freeze({ ...settings, displayName, endpoint: url.toString() });
}

function validateCredential(credential: string): string {
  const bytes = Buffer.byteLength(credential, "utf8");
  if (
    bytes < 1 ||
    bytes > 8192 ||
    credential.trim() !== credential ||
    /[^\x20-\x7E]/u.test(credential)
  )
    throw new ExternalToolAdminError(
      "INVALID",
      "凭据不能为空、不得超过 8192 字节，且只能包含无首尾空白的可打印 ASCII 字符",
    );
  return credential;
}

function publicProbeTool(tool: McpProbeToolResult): AdminMcpProbeTool {
  if (tool.accepted)
    return {
      accepted: true,
      remoteToolName: tool.remoteToolName,
      modelToolName: tool.modelToolName,
      description: tool.description,
      inputSchemaDigest: tool.inputSchemaDigest,
    };
  return {
    accepted: false,
    ...(tool.remoteToolName === undefined ? {} : { remoteToolName: tool.remoteToolName }),
    reason: tool.reason,
    reasonMessage: tool.reasonMessage,
  };
}

export class ExternalToolAdminService {
  private readonly repository: ExternalToolAdminRepositoryPort;
  private readonly probePort: McpProbePort;
  private readonly httpPreview: HttpToolPreviewPort;

  constructor(
    repository: ExternalToolAdminRepositoryPort,
    probe: McpProbePort,
    httpPreview: HttpToolPreviewPort,
  ) {
    this.repository = repository;
    this.probePort = probe;
    this.httpPreview = httpPreview;
  }

  overview(actorUserId: string): Promise<AdminExternalToolOverview> {
    return this.repository.overview(actorUserId);
  }

  createMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly settings: AdminMcpDraftSettings;
      readonly credential?: string;
      readonly expectedGeneration: number;
    },
  ): Promise<AdminMcpDraftDto> {
    if (input.expectedGeneration !== 0)
      throw new ExternalToolAdminError("CONFLICT", "新建草稿的 generation 必须为 0");
    return this.repository.createMcpDraft({
      actorUserId: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
      draftId: input.draftId,
      settings: validateMcpDraftSettings(input.settings),
      ...(input.credential === undefined
        ? {}
        : { credential: validateCredential(input.credential) }),
    });
  }

  updateMcpDraft(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly settings: AdminMcpDraftSettings;
    },
  ): Promise<AdminMcpDraftDto> {
    return this.repository.updateMcpDraft({
      ...input,
      settings: validateMcpDraftSettings(input.settings),
    });
  }

  setDraftCredential(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
      readonly credential: string | null;
    },
  ): Promise<AdminMcpDraftDto> {
    return this.repository.setDraftCredential({
      ...input,
      credential: input.credential === null ? null : validateCredential(input.credential),
    });
  }

  /** 探测不改变草稿；结果只用于展示，正式发布会重新探测并整批校验。 */
  async probe(input: {
    readonly actorUserId: string;
    readonly draftId: string;
    readonly expectedGeneration: number;
  }): Promise<AdminMcpProbeReport> {
    const loaded = await this.repository.loadDraftForProbe(input);
    const base = { draftId: loaded.draft.draftId, generation: loaded.draft.generation };
    let tools: readonly McpProbeToolResult[];
    try {
      tools = await this.runProbe(loaded);
    } catch {
      const failure = probeFailure;
      await this.repository.recordProbeAudit({
        actorUserId: input.actorUserId,
        draftId: input.draftId,
        action: "probed",
        outcome: "failed",
        reason: failure.message,
      });
      return { ...base, publishable: false, failure, tools: [] };
    }
    const rejected = tools.filter((tool) => !tool.accepted).length;
    const publishable = tools.length > 0 && rejected === 0;
    await this.repository.recordProbeAudit({
      actorUserId: input.actorUserId,
      draftId: input.draftId,
      action: "probed",
      outcome: publishable ? "succeeded" : "rejected",
      reason: summary(tools.length, rejected),
    });
    return { ...base, publishable, tools: tools.map(publicProbeTool) };
  }

  /** 发布前重新探测；任一工具不合规或清单为空时整批拒绝，不写入任何版本。 */
  async publish(
    input: ExternalToolCommandContext & {
      readonly draftId: string;
      readonly expectedGeneration: number;
    },
  ): Promise<AdminExternalToolBatchDto> {
    const replay = await this.repository.replayPublish(input);
    if (replay !== undefined) return replay;
    const loaded = await this.repository.loadDraftForProbe(input);
    let tools: readonly McpProbeToolResult[];
    try {
      tools = await this.runProbe(loaded);
    } catch {
      const failure = probeFailure;
      await this.repository.recordProbeAudit({
        actorUserId: input.actorUserId,
        draftId: input.draftId,
        action: "published",
        outcome: "failed",
        reason: failure.message,
      });
      throw new ExternalToolAdminError("PROBE_UNAVAILABLE", `发布前探测失败：${failure.message}`);
    }
    const accepted = tools.filter(
      (tool): tool is AcceptedMcpProbeTool & { accepted: true } => tool.accepted,
    );
    if (tools.length === 0 || accepted.length !== tools.length) {
      const reason = summary(tools.length, tools.length - accepted.length);
      await this.repository.recordProbeAudit({
        actorUserId: input.actorUserId,
        draftId: input.draftId,
        action: "published",
        outcome: "rejected",
        reason,
      });
      throw new ExternalToolAdminError(
        "PUBLISH_REJECTED",
        tools.length === 0
          ? "Server 未返回任何工具，未发布"
          : `${tools.length - accepted.length} 个工具不符合平台要求，整批未发布`,
      );
    }
    return this.repository.publishMcpBatch({
      ...input,
      tools: accepted.map(({ accepted: _accepted, ...tool }) => tool),
    });
  }

  revokeBatch(
    input: ExternalToolCommandContext & { readonly batchId: string; readonly reason: string },
  ): Promise<AdminExternalToolBatchDto> {
    const reason = input.reason.trim();
    if (!reason || Buffer.byteLength(reason, "utf8") > 500)
      throw new ExternalToolAdminError("INVALID", "撤销原因不能为空，且不得超过 500 字节");
    return this.repository.revokeBatch({ ...input, reason });
  }

  async previewHttpTool(
    actorUserId: string,
    input: AdminHttpToolPreviewRequest,
  ): Promise<AdminHttpToolPreview> {
    await this.repository.requireAdmin(actorUserId);
    try {
      return this.httpPreview(input);
    } catch {
      throw new ExternalToolAdminError(
        "INVALID",
        "HTTP 工具声明不符合平台支持的子集：仅支持 HTTPS、GET/POST、JSON 参数与受控 Schema",
      );
    }
  }

  private async runProbe(loaded: {
    readonly draft: AdminMcpDraftDto;
    readonly credential?: string;
  }): Promise<readonly McpProbeToolResult[]> {
    const tools = await this.probePort({
      endpoint: loaded.draft.endpoint,
      serverName: loaded.draft.serverName,
      timeoutMs: loaded.draft.timeoutMs,
      maxResponseBytes: loaded.draft.maxResponseBytes,
      ...(loaded.credential === undefined ? {} : { credential: loaded.credential }),
    });
    const { credential } = loaded;
    if (credential === undefined) return tools;
    // 报告与发布共用此边界：远端反射凭据时拒绝整个工具，不保留名称或 Schema。
    return tools.map((tool) =>
      containsCredential(tool, credential)
        ? {
            accepted: false,
            reason: "MCP_UNSAFE_METADATA",
            reasonMessage: "远端工具元数据不允许展示或发布",
          }
        : tool,
    );
  }
}

function summary(total: number, rejected: number): string {
  return total === 0 ? "Server 未返回任何工具" : `共 ${total} 个工具，${rejected} 个不符合要求`;
}

const probeFailure = {
  code: "EXTERNAL_TOOL_UNAVAILABLE",
  message: "无法连接 MCP Server 或响应不符合协议",
} as const;

/** 检查原始字符串而不是序列化 JSON，避免凭据中的引号、反斜线被转义后漏检。 */
function containsCredential(value: unknown, credential: string): boolean {
  if (typeof value === "string") return value.includes(credential);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) => key.includes(credential) || containsCredential(item, credential),
  );
}
