export type Thread = {
  readonly id: string;
  readonly tenantId?: string;
  readonly createdByUserId?: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TeamSummary = {
  readonly id: string;
  readonly displayName: string;
  readonly role: "owner" | "admin" | "member";
  readonly joinedAt: string;
};

export type TeamMember = {
  readonly membershipId: string;
  readonly userId: string;
  readonly role: "owner" | "admin" | "member";
  readonly joinedAt: string;
};

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type Run = {
  readonly id: string;
  readonly threadId: string;
  readonly status: RunStatus;
  /** Domain Run 仍可为 running，但该 durable 投影证明当前 Attempt 已停止执行。 */
  readonly executionStatus?: "recovery_required";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ThreadInputReceipt = {
  readonly receiptId: string;
  readonly inputSequence: number;
  readonly requestedMode: "auto" | "steer" | "follow_up";
  readonly disposition: "pending_steer" | "steered" | "queued" | "cancelled" | "rejected";
  readonly targetRunId?: string;
  readonly targetTurnId?: string;
  readonly queuedRunId?: string;
  readonly queueSequence?: number;
  readonly appliedContextSequence?: number;
  readonly rejectionCode?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly queuedRun?: Run;
};

export type UploadedResource = {
  readonly resourceId: string;
  readonly versionId: string;
  readonly name: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
};

export type HistoryFile = {
  readonly threadId: string;
  readonly taskName: string;
  readonly resourceId: string;
  readonly versionId: string;
  readonly name: string;
  readonly entryName: string;
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly attachedAt: string;
};

export type HistoryFileTask = {
  readonly threadId: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastFileAt: string;
  readonly fileCount: number;
  readonly files: readonly HistoryFile[];
};

export type HistoryFilePage = {
  readonly items: readonly HistoryFileTask[];
  readonly range: Readonly<{ activeAfter?: string; activeBefore?: string }>;
  readonly hasMore: boolean;
  readonly hasOlder: boolean;
  readonly next?: Readonly<{ lastFileAt: string; threadId: string }>;
};

export type HistoryFileListOptions = {
  readonly query?: string;
  readonly activeAfter?: string;
  readonly activeBefore?: string;
  readonly before?: Readonly<{ lastFileAt: string; threadId: string }>;
  readonly limit?: number;
};

export type SkillCatalogItem = {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly description: string;
  readonly recommendedVersion: string;
  readonly compatibility: string;
  readonly securityStatus: "verified" | "restricted";
};

export type SkillCatalogPage = {
  readonly items: readonly SkillCatalogItem[];
  readonly nextCursor?: string;
};

export type SkillInstallation = {
  readonly canonicalKey: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly description: string;
  readonly skillVersion: string;
  readonly invocationName: string;
  readonly status: "enabled" | "disabled";
  readonly versionToken: number;
  readonly installedAt: string;
  readonly updatedAt: string;
};

export type RunEvent = {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: string;
  readonly type: string;
  readonly payload: unknown;
};

export type RunEventPage = {
  readonly attemptId: string | undefined;
  readonly items: readonly RunEvent[];
  readonly hasMore?: boolean;
};

export type ThreadContextMessage = {
  readonly sequence: number;
  readonly runId?: string;
  readonly role: "user" | "assistant" | "runtime";
  readonly text: string;
  readonly createdAt: string;
};

export type ThreadContinuityStatus = {
  readonly boundary: "new_thread" | "legacy_anchor" | "manual" | "unmigrated";
  readonly readMode: "legacy" | "v2";
  readonly anchorState: "none" | "completed";
  readonly queueDepth: number;
  readonly contextSequence: number;
  readonly compactionWindow: number;
  readonly sandboxState?: "running" | "pausing" | "paused" | "resuming" | "terminated" | "unknown";
};

export type ModelWireTraceCaptureStatus = "complete" | "truncated" | "aborted" | "failed";
export type ModelWireTracePersistenceStatus =
  | "pending"
  | "stored"
  | "unknown"
  | "conflict"
  | "unavailable"
  | "not_captured";
export type ModelWireTraceRecord = {
  readonly attemptId: string;
  readonly modelTurn: number;
  readonly transportAttempt: number;
  readonly part: "request" | "response";
  readonly captureStatus: ModelWireTraceCaptureStatus;
  readonly persistenceStatus: ModelWireTracePersistenceStatus;
  readonly captureErrorCode?: "CAPTURE_UNAVAILABLE" | "BODY_UNREADABLE";
  readonly httpStatus?: number;
  readonly sha256?: string;
  readonly size?: number;
  readonly bodyAvailable: boolean;
  readonly createdAt: string;
  readonly expiresAt: string;
};
export type ModelWireTracePage = {
  readonly items: readonly ModelWireTraceRecord[];
  readonly hasMore: boolean;
  readonly unavailable?: boolean;
  readonly nextCursor?: string;
};

export const EVENT_PAGE_LIMIT = 100;

/** 原生浏览器 fetch 必须由 Window/globalThis 作为 receiver 调用，不能直接存成实例方法。 */
const defaultFetcher: typeof fetch = (input, init) => globalThis.fetch(input, init);

export type Artifact = {
  readonly id: string;
  readonly name: string;
  readonly status: "publishing" | "published" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
};

export type ArtifactPreview =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "url"; readonly url: string };

type Envelope<T> = { readonly version: "v1"; readonly requestId: string; readonly data: T };
type ErrorEnvelope = {
  readonly error?: {
    readonly message?: string;
    readonly code?: string;
    readonly retryable?: boolean;
  };
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function createKey(): string {
  return crypto.randomUUID();
}

function envelope<T>(value: unknown): T {
  if (typeof value !== "object" || value === null || !("data" in value)) {
    throw new ApiError("服务响应格式无效", 502, true);
  }
  return (value as Envelope<T>).data;
}

function asArray(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null && "items" in value) {
    const items = (value as { readonly items?: unknown }).items;
    return Array.isArray(items) ? items : [];
  }
  return [];
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const modelWireCaptureStatuses = new Set<ModelWireTraceCaptureStatus>([
  "complete",
  "truncated",
  "aborted",
  "failed",
]);
const modelWirePersistenceStatuses = new Set<ModelWireTracePersistenceStatus>([
  "pending",
  "stored",
  "unknown",
  "conflict",
  "unavailable",
  "not_captured",
]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

export function normalizeModelWireTrace(value: unknown): ModelWireTraceRecord | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const captureStatus = raw.captureStatus;
  const persistenceStatus = raw.persistenceStatus;
  if (
    typeof raw.attemptId !== "string" ||
    !Number.isSafeInteger(raw.modelTurn) ||
    (raw.modelTurn as number) < 0 ||
    !Number.isSafeInteger(raw.transportAttempt) ||
    (raw.transportAttempt as number) < 0 ||
    (raw.part !== "request" && raw.part !== "response") ||
    typeof captureStatus !== "string" ||
    !modelWireCaptureStatuses.has(captureStatus as ModelWireTraceCaptureStatus) ||
    typeof persistenceStatus !== "string" ||
    !modelWirePersistenceStatuses.has(persistenceStatus as ModelWireTracePersistenceStatus) ||
    typeof raw.bodyAvailable !== "boolean" ||
    typeof raw.createdAt !== "string" ||
    typeof raw.expiresAt !== "string"
  ) {
    return undefined;
  }
  const httpStatus =
    Number.isInteger(raw.httpStatus) &&
    (raw.httpStatus as number) >= 100 &&
    (raw.httpStatus as number) <= 599
      ? (raw.httpStatus as number)
      : undefined;
  const sha256 =
    typeof raw.sha256 === "string" && sha256Pattern.test(raw.sha256) ? raw.sha256 : undefined;
  const size =
    Number.isSafeInteger(raw.size) && (raw.size as number) >= 0 ? (raw.size as number) : undefined;
  const captureErrorCode =
    raw.captureErrorCode === "CAPTURE_UNAVAILABLE" || raw.captureErrorCode === "BODY_UNREADABLE"
      ? raw.captureErrorCode
      : undefined;
  return {
    attemptId: raw.attemptId,
    modelTurn: raw.modelTurn as number,
    transportAttempt: raw.transportAttempt as number,
    part: raw.part,
    captureStatus: captureStatus as ModelWireTraceCaptureStatus,
    persistenceStatus: persistenceStatus as ModelWireTracePersistenceStatus,
    ...(captureErrorCode === undefined ? {} : { captureErrorCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(size === undefined ? {} : { size }),
    bodyAvailable: raw.bodyAvailable,
    createdAt: raw.createdAt,
    expiresAt: raw.expiresAt,
  };
}

/** 将追加日志基线和未来的 HTTP 事件信封收敛为 UI 的稳定事件形状。 */
export function normalizeRunEvent(value: unknown): RunEvent | undefined {
  const raw = record(value);
  if (
    raw === undefined ||
    typeof raw.sequence !== "number" ||
    !Number.isSafeInteger(raw.sequence)
  ) {
    return undefined;
  }
  const kind = typeof raw.kind === "string" ? raw.kind : "unknown";
  const payload = raw.payload;
  const payloadType = record(payload)?.type;
  // 旧开发进程会把 agent_event 写进 raw.type；其 payload.type 才是可呈现的事件类型。
  const type =
    kind === "agent_event" && typeof payloadType === "string"
      ? payloadType
      : typeof raw.type === "string"
        ? raw.type
        : kind;
  return {
    eventId: typeof raw.eventId === "string" ? raw.eventId : `event-${raw.sequence}`,
    sequence: raw.sequence,
    occurredAt: typeof raw.occurredAt === "string" ? raw.occurredAt : "",
    kind,
    type,
    payload,
  };
}

export class RuntimeApi {
  private activeTenantId: string | undefined;

  constructor(
    private readonly fetcher: typeof fetch = defaultFetcher,
    private readonly baseUrl = "/api",
  ) {}

  setTenantId(tenantId: string | undefined): void {
    this.activeTenantId = tenantId;
  }

  getTenantId(): string | undefined {
    return this.activeTenantId;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    tenantId: string | undefined = this.activeTenantId,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer dev-user-a");
    headers.set("Accept", "application/json");
    if (tenantId !== undefined) headers.set("X-Tenant-ID", tenantId);
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (["POST", "PUT", "PATCH", "DELETE"].includes(init.method ?? "GET")) {
      headers.set("Idempotency-Key", createKey());
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { ...init, headers });
    } catch {
      throw new ApiError("无法连接本地运行时", 0, true);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body as ErrorEnvelope | undefined;
      throw new ApiError(
        error?.error?.message ?? "请求失败",
        response.status,
        error?.error?.retryable ?? response.status >= 500,
      );
    }
    return envelope<T>(body);
  }

  private async requestBytes(path: string, tenantId = this.activeTenantId): Promise<Uint8Array> {
    const headers = new Headers({
      Authorization: "Bearer dev-user-a",
      Accept: "application/octet-stream",
    });
    if (tenantId !== undefined) headers.set("X-Tenant-ID", tenantId);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, { headers });
    } catch {
      throw new ApiError("无法连接本地运行时", 0, true);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => undefined)) as ErrorEnvelope | undefined;
      throw new ApiError(
        body?.error?.message ?? "诊断正文不可用或已过期",
        response.status,
        body?.error?.retryable ?? response.status >= 500,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async listThreads(): Promise<readonly Thread[]> {
    return asArray(await this.request<unknown>("/v1/threads?limit=100")) as readonly Thread[];
  }

  async listTeams(): Promise<readonly TeamSummary[]> {
    return asArray(await this.request<unknown>("/v1/me/teams")) as readonly TeamSummary[];
  }

  createTeam(displayName: string): Promise<TeamSummary> {
    return this.request("/v1/teams", {
      method: "POST",
      body: JSON.stringify({ displayName }),
    });
  }

  async listTeamMembers(teamId: string): Promise<readonly TeamMember[]> {
    return asArray(
      await this.request<unknown>(`/v1/teams/${encodeURIComponent(teamId)}/members`),
    ) as readonly TeamMember[];
  }

  addTeamMember(
    teamId: string,
    userId: string,
    role: "admin" | "member" = "member",
  ): Promise<TeamMember> {
    return this.request(`/v1/teams/${encodeURIComponent(teamId)}/members`, {
      method: "POST",
      body: JSON.stringify({ userId, role }),
    });
  }

  changeTeamMemberRole(
    teamId: string,
    userId: string,
    role: TeamMember["role"],
  ): Promise<TeamMember> {
    return this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
    );
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
    );
  }

  async dissolveTeam(teamId: string): Promise<void> {
    await this.request(`/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
  }
  getThread(threadId: string): Promise<Thread> {
    return this.request(`/v1/threads/${encodeURIComponent(threadId)}`);
  }

  async listHistoryFiles(options: HistoryFileListOptions = {}): Promise<HistoryFilePage> {
    return this.listHistoryFilesForTenant(this.activeTenantId, options);
  }

  async listHistoryFilesForTenant(
    tenantId: string | undefined,
    options: HistoryFileListOptions = {},
  ): Promise<HistoryFilePage> {
    const query = new URLSearchParams();
    if (options.query?.trim()) query.set("q", options.query.trim());
    if (options.activeAfter !== undefined) query.set("activeAfter", options.activeAfter);
    if (options.activeBefore !== undefined) query.set("activeBefore", options.activeBefore);
    if (options.before !== undefined) {
      query.set("beforeLastFileAt", options.before.lastFileAt);
      query.set("beforeThreadId", options.before.threadId);
    }
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.request<HistoryFilePage>(`/v1/me/history-files${suffix}`, {}, tenantId);
  }

  async downloadHistoryFile(file: Pick<HistoryFile, "resourceId" | "versionId">): Promise<string> {
    return this.downloadHistoryFileForTenant(this.activeTenantId, file);
  }

  async downloadHistoryFileForTenant(
    tenantId: string | undefined,
    file: Pick<HistoryFile, "resourceId" | "versionId">,
  ): Promise<string> {
    const data = await this.request<unknown>(
      `/v1/me/history-files/${encodeURIComponent(file.resourceId)}/versions/${encodeURIComponent(file.versionId)}/download`,
      {},
      tenantId,
    );
    const candidate = record(data)?.url;
    if (typeof candidate === "string") return candidate;
    throw new ApiError("历史文件下载地址格式无效", 502, true);
  }

  async listSkills(query = ""): Promise<SkillCatalogPage> {
    const suffix = query.trim().length === 0 ? "" : `?q=${encodeURIComponent(query.trim())}`;
    return this.request<SkillCatalogPage>(`/v1/skills${suffix}`);
  }

  async listInstalledSkills(): Promise<readonly SkillInstallation[]> {
    return asArray(await this.request<unknown>("/v1/me/skills")) as readonly SkillInstallation[];
  }

  async installSkill(canonicalKey: string, invocationName: string): Promise<SkillInstallation> {
    return this.request<SkillInstallation>(`/v1/me/skills/${encodeURIComponent(canonicalKey)}`, {
      method: "PUT",
      body: JSON.stringify({ version: "recommended", invocationName }),
    });
  }

  async setSkillEnabled(
    installation: SkillInstallation,
    enabled: boolean,
  ): Promise<SkillInstallation> {
    return this.request<SkillInstallation>(
      `/v1/me/skills/${encodeURIComponent(installation.canonicalKey)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          expectedVersionToken: installation.versionToken,
          enabled,
        }),
      },
    );
  }

  async uninstallSkill(installation: SkillInstallation): Promise<void> {
    await this.request(
      `/v1/me/skills/${encodeURIComponent(installation.canonicalKey)}?expectedVersionToken=${installation.versionToken}`,
      { method: "DELETE" },
    );
  }
  /**
   * 读取 Thread 在本次服务端快照中的最新 Run 窗口；它不是跨写入可续接的历史分页。
   * 恢复入口通常只需 limit=1，随后仍须分别按该 Run 拉取最新 Attempt 的事件和 Artifact。
   */
  async listLatestRuns(threadId: string, limit = 1): Promise<readonly Run[]> {
    return asArray(
      await this.request<unknown>(
        `/v1/threads/${encodeURIComponent(threadId)}/runs?limit=${limit}`,
      ),
    ) as readonly Run[];
  }
  async listThreadContext(threadId: string): Promise<readonly ThreadContextMessage[] | undefined> {
    const items: ThreadContextMessage[] = [];
    let after = 0;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      let data: unknown;
      try {
        data = await this.request<unknown>(
          `/v1/threads/${encodeURIComponent(threadId)}/context?after=${after}&limit=500`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return undefined;
        throw error;
      }
      const page = record(data);
      const incoming = asArray(data).filter(isThreadContextMessage);
      items.push(...incoming);
      if (page?.hasMore !== true) return items;
      const next = incoming.at(-1)?.sequence;
      if (next === undefined || next <= after)
        throw new ApiError("Thread 历史游标无进展", 502, true);
      after = next;
    }
    throw new ApiError("Thread 历史超过当前客户端分页上限", 422, false);
  }
  async getThreadContinuity(threadId: string): Promise<ThreadContinuityStatus | undefined> {
    try {
      const value = await this.request<unknown>(
        `/v1/threads/${encodeURIComponent(threadId)}/continuity`,
      );
      return isThreadContinuityStatus(value) ? value : undefined;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return undefined;
      throw error;
    }
  }
  createThread(title: string): Promise<Thread> {
    return this.request("/v1/threads", { method: "POST", body: JSON.stringify({ title }) });
  }
  forkThread(threadId: string, targetTeamId?: string): Promise<Thread> {
    return this.request(`/v1/threads/${encodeURIComponent(threadId)}/forks`, {
      method: "POST",
      body: JSON.stringify(targetTeamId === undefined ? {} : { targetTeamId }),
    });
  }

  importTeamFile(
    sourceTeamId: string,
    file: Pick<HistoryFile, "resourceId" | "versionId">,
  ): Promise<UploadedResource> {
    return this.request("/v1/me/team-files/import", {
      method: "POST",
      body: JSON.stringify({ sourceTeamId, ...file }),
    });
  }
  archiveThread(threadId: string): Promise<Thread> {
    return this.request(`/v1/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
  }
  createRun(threadId: string, input: string): Promise<Run> {
    return this.request(`/v1/threads/${encodeURIComponent(threadId)}/runs`, {
      method: "POST",
      body: JSON.stringify({ input }),
    });
  }
  async submitThreadInput(
    threadId: string,
    input: string,
    mode: "auto" | "follow_up" = "auto",
    expectedRunId?: string,
    attachments: readonly Pick<UploadedResource, "resourceId" | "versionId">[] = [],
  ): Promise<ThreadInputReceipt> {
    try {
      return await this.request(`/v1/threads/${encodeURIComponent(threadId)}/inputs`, {
        method: "POST",
        body: JSON.stringify({
          input,
          mode,
          ...(expectedRunId === undefined ? {} : { expectedRunId }),
          ...(attachments.length === 0
            ? {}
            : {
                attachments: attachments.map(({ resourceId, versionId }) => ({
                  resourceId,
                  versionId,
                })),
              }),
        }),
      });
    } catch (error) {
      // Feature Flag 关闭或旧 API：统一入口不存在时保持 /runs=follow_up 的兼容语义。
      if (!(error instanceof ApiError) || error.status !== 404 || attachments.length > 0)
        throw error;
      const run = await this.createRun(threadId, input);
      return {
        receiptId: `legacy-${run.id}`,
        inputSequence: 1,
        requestedMode: "follow_up",
        disposition: "queued",
        queuedRunId: run.id,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        queuedRun: run,
      };
    }
  }
  async uploadResource(file: File, idempotencyKey = createKey()): Promise<UploadedResource> {
    const headers = new Headers({
      Authorization: "Bearer dev-user-a",
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "Idempotency-Key": idempotencyKey,
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Media-Type": file.type || "application/octet-stream",
    });
    if (this.activeTenantId !== undefined) headers.set("X-Tenant-ID", this.activeTenantId);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/v1/resources/uploads`, {
        method: "POST",
        headers,
        body: await file.arrayBuffer(),
      });
    } catch {
      throw new ApiError("上传文件失败：无法连接本地运行时", 0, true);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const error = body as ErrorEnvelope | undefined;
      throw new ApiError(
        error?.error?.message ?? "上传文件失败",
        response.status,
        error?.error?.retryable ?? response.status >= 500,
      );
    }
    return envelope<UploadedResource>(body);
  }
  getThreadInputReceipt(threadId: string, receiptId: string): Promise<ThreadInputReceipt> {
    return this.request(
      `/v1/threads/${encodeURIComponent(threadId)}/inputs/${encodeURIComponent(receiptId)}`,
    );
  }
  getRun(threadId: string, runId: string): Promise<Run> {
    return this.request(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
    );
  }
  cancelRun(threadId: string, runId: string): Promise<Run> {
    return this.request(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}`,
      {
        method: "DELETE",
      },
    );
  }
  async listEvents(
    threadId: string,
    runId: string,
    after = -1,
    limit = EVENT_PAGE_LIMIT,
  ): Promise<RunEventPage> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=${limit}`,
    );
    const page = record(data);
    const hasMore = typeof page?.hasMore === "boolean" ? page.hasMore : undefined;
    return {
      attemptId: typeof page?.attemptId === "string" ? page.attemptId : undefined,
      items: asArray(data)
        .map(normalizeRunEvent)
        .filter((event): event is RunEvent => event !== undefined),
      ...(hasMore === undefined ? {} : { hasMore }),
    };
  }
  async listArtifacts(threadId: string, runId: string): Promise<readonly Artifact[]> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/artifacts`,
    );
    return asArray(data) as readonly Artifact[];
  }
  async listModelWireTraces(
    threadId: string,
    runId: string,
    cursor?: string,
  ): Promise<ModelWireTracePage> {
    let data: unknown;
    try {
      const query = new URLSearchParams({ limit: "500" });
      if (cursor !== undefined) query.set("cursor", cursor);
      data = await this.request<unknown>(
        `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/model-wire-traces?${query.toString()}`,
      );
    } catch (error) {
      // 诊断默认关闭或旧 API 尚未部署时保持现有 Run 体验，不把可选诊断变成轮询故障。
      if (error instanceof ApiError && error.status === 404) return { items: [], hasMore: false };
      throw error;
    }
    const page = record(data);
    const nextCursor = typeof page?.nextCursor === "string" ? page.nextCursor : undefined;
    return {
      items: asArray(data)
        .map(normalizeModelWireTrace)
        .filter((item): item is ModelWireTraceRecord => item !== undefined),
      hasMore: page?.hasMore === true && nextCursor !== undefined,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  getModelWireTraceBody(
    threadId: string,
    runId: string,
    trace: Pick<ModelWireTraceRecord, "attemptId" | "modelTurn" | "transportAttempt" | "part">,
  ): Promise<Uint8Array> {
    return this.requestBytes(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/model-wire-traces/${encodeURIComponent(trace.attemptId)}/${trace.modelTurn}/${trace.transportAttempt}/${trace.part}/body`,
    );
  }
  async downloadArtifact(threadId: string, runId: string, artifactId: string): Promise<string> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/download`,
    );
    if (typeof data === "object" && data !== null) {
      const candidate =
        (data as { readonly url?: unknown; readonly downloadUrl?: unknown }).url ??
        (data as { readonly downloadUrl?: unknown }).downloadUrl;
      if (typeof candidate === "string") return candidate;
    }
    throw new ApiError("下载地址格式无效", 502, true);
  }
  async previewArtifact(
    threadId: string,
    runId: string,
    artifactId: string,
  ): Promise<ArtifactPreview> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/preview`,
    );
    if (typeof data === "object" && data !== null) {
      const text = (data as { readonly text?: unknown }).text;
      if (typeof text === "string") return { kind: "text", text };
      const candidate =
        (data as { readonly url?: unknown; readonly previewUrl?: unknown }).url ??
        (data as { readonly previewUrl?: unknown }).previewUrl;
      if (typeof candidate === "string") return { kind: "url", url: candidate };
    }
    throw new ApiError("预览地址格式无效", 502, true);
  }
}

function isThreadContextMessage(value: unknown): value is ThreadContextMessage {
  const item = record(value);
  return (
    item !== undefined &&
    typeof item.sequence === "number" &&
    Number.isSafeInteger(item.sequence) &&
    item.sequence > 0 &&
    (item.role === "user" || item.role === "assistant" || item.role === "runtime") &&
    typeof item.text === "string" &&
    typeof item.createdAt === "string"
  );
}

function isThreadContinuityStatus(value: unknown): value is ThreadContinuityStatus {
  const item = record(value);
  return (
    item !== undefined &&
    (item.boundary === "new_thread" ||
      item.boundary === "legacy_anchor" ||
      item.boundary === "manual" ||
      item.boundary === "unmigrated") &&
    (item.readMode === "legacy" || item.readMode === "v2") &&
    (item.anchorState === "none" || item.anchorState === "completed") &&
    Number.isSafeInteger(item.queueDepth) &&
    (item.queueDepth as number) >= 0 &&
    Number.isSafeInteger(item.contextSequence) &&
    (item.contextSequence as number) >= 0 &&
    Number.isSafeInteger(item.compactionWindow) &&
    (item.compactionWindow as number) >= 0 &&
    (item.sandboxState === undefined ||
      new Set(["running", "pausing", "paused", "resuming", "terminated", "unknown"]).has(
        item.sandboxState as string,
      ))
  );
}

export function canPreviewArtifact(mediaType: string | undefined): boolean {
  if (mediaType === undefined) return false;
  const [rawBase, ...rawParameters] = mediaType.split(";");
  const base = rawBase?.trim().toLowerCase();
  if (base === "text/plain") {
    return /^text\/plain\s*;\s*charset\s*=\s*utf-8\s*$/iu.test(mediaType);
  }
  return (
    rawParameters.length === 0 &&
    new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]).has(
      base ?? "",
    )
  );
}
