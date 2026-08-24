export type AccountProfile = {
  readonly id: string;
  readonly displayName: string;
  readonly email: string;
};

export type AccountSession = {
  readonly profile: AccountProfile;
  readonly accessToken: string;
  readonly expiresAt: string;
};

export type IdentityProviderKey = "google" | "github" | "wechat" | "qq";

export type IdentityAuthConfiguration = {
  readonly emailPasswordEnabled: boolean;
  readonly registrationEnabled: boolean;
  readonly phoneEnabled: boolean;
  readonly providers: readonly {
    readonly key: IdentityProviderKey;
    readonly enabled: boolean;
  }[];
};

export type Thread = {
  readonly id: string;
  readonly tenantId?: string;
  readonly createdByUserId?: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ScheduledTask = {
  readonly id: string;
  readonly tenantId: string;
  readonly ownerUserId: string;
  readonly sourceThreadId: string;
  readonly targetThreadId: string;
  readonly name: string;
  readonly instruction: string;
  readonly timezone: string;
  readonly rrule?: string;
  readonly status: "active" | "paused" | "completed" | "deleted";
  readonly overlapPolicy: "coalesce" | "skip";
  readonly nextRunAt?: string;
  readonly lastRunAt?: string;
  readonly currentRevision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type CreateScheduledTaskInput = {
  readonly targetThreadId: string;
  readonly name: string;
  readonly instruction: string;
  readonly firstRunAt: string;
  readonly rrule?: string;
  readonly timezone: string;
  readonly overlapPolicy?: "coalesce" | "skip";
};

export type UpdateScheduledTaskInput =
  | { readonly action: "pause" | "resume" | "delete" }
  | {
      readonly action: "update";
      readonly name?: string;
      readonly instruction?: string;
      readonly firstRunAt?: string;
      readonly rrule?: string | null;
      readonly timezone?: string;
      readonly overlapPolicy?: "coalesce" | "skip";
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

export type PersonalPersonalization = {
  readonly content: string;
  readonly applyToTeamTasks: boolean;
  readonly version: number;
  readonly updatedAt?: string;
};

export type TeamPersonalization = {
  readonly teamId: string;
  readonly content: string;
  readonly version: number;
  readonly canEdit: boolean;
  readonly updatedAt?: string;
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
  readonly phase?: "commentary" | "final_answer";
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
  private accessToken: string | undefined;

  constructor(
    private readonly fetcher: typeof fetch = defaultFetcher,
    private readonly baseUrl = "/api",
  ) {}

  setAccessToken(accessToken: string | undefined): void {
    this.accessToken = accessToken;
  }

  setTenantId(tenantId: string | undefined): void {
    this.activeTenantId = tenantId;
  }

  getTenantId(): string | undefined {
    return this.activeTenantId;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    tenantId: string | null | undefined = this.activeTenantId,
    authenticated = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (authenticated && this.accessToken !== undefined) {
      headers.set("Authorization", `Bearer ${this.accessToken}`);
    }
    headers.set("Accept", "application/json");
    if (tenantId !== undefined && tenantId !== null) headers.set("X-Tenant-ID", tenantId);
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

  private async betterAuthRequest<T>(path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError("无法连接身份服务", 0, true);
    }
    const value: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw new ApiError("身份验证失败", response.status, response.status >= 500);
    return value as T;
  }

  getIdentityConfiguration(): Promise<IdentityAuthConfiguration> {
    return this.request("/v1/auth/config", {}, null, false);
  }

  exchangeIdentitySession(): Promise<AccountSession> {
    return this.request("/v1/auth/exchange", { method: "POST" }, null, false);
  }

  async signUpWithEmail(input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession> {
    await this.betterAuthRequest("/sign-up/email", {
      name: input.displayName,
      email: input.email,
      password: input.password,
    });
    return this.exchangeIdentitySession();
  }

  async signInWithEmail(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession> {
    await this.betterAuthRequest("/sign-in/email", input);
    return this.exchangeIdentitySession();
  }

  async beginSocialSignIn(provider: IdentityProviderKey, callbackURL: string): Promise<string> {
    const result = await this.betterAuthRequest<{ readonly url?: unknown }>("/sign-in/social", {
      provider,
      callbackURL,
      disableRedirect: true,
    });
    if (typeof result.url !== "string") throw new ApiError("身份服务未返回跳转地址", 502, true);
    const url = new URL(result.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ApiError("身份服务返回了不安全的跳转地址", 502, false);
    }
    return url.href;
  }

  async sendPhoneOtp(phoneNumber: string): Promise<void> {
    await this.betterAuthRequest("/phone-number/send-otp", { phoneNumber });
  }

  async verifyPhoneOtp(phoneNumber: string, code: string): Promise<AccountSession> {
    await this.betterAuthRequest("/phone-number/verify", { phoneNumber, code });
    return this.exchangeIdentitySession();
  }

  registerAccount(input: {
    readonly displayName: string;
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession> {
    return this.request(
      "/v1/auth/register",
      { method: "POST", body: JSON.stringify(input) },
      null,
      false,
    );
  }

  loginAccount(input: {
    readonly email: string;
    readonly password: string;
  }): Promise<AccountSession> {
    return this.request(
      "/v1/auth/login",
      { method: "POST", body: JSON.stringify(input) },
      null,
      false,
    );
  }

  getCurrentAccount(): Promise<AccountProfile> {
    return this.request("/v1/auth/me", {}, null);
  }

  async logoutAccount(): Promise<void> {
    const results = await Promise.allSettled([
      this.request<{ readonly loggedOut: true }>("/v1/auth/logout", { method: "POST" }, null),
      this.betterAuthRequest("/sign-out", {}),
    ]);
    if (results.every((result) => result.status === "rejected")) {
      throw results[0]?.status === "rejected" ? results[0].reason : new Error("LOGOUT_FAILED");
    }
  }

  async listThreads(): Promise<readonly Thread[]> {
    return this.listThreadsForTenant(this.activeTenantId);
  }

  async listThreadsForTenant(tenantId: string | undefined): Promise<readonly Thread[]> {
    return asArray(
      await this.request<unknown>("/v1/threads?limit=100", {}, tenantId ?? null),
    ) as readonly Thread[];
  }

  async listTeams(): Promise<readonly TeamSummary[]> {
    return asArray(await this.request<unknown>("/v1/me/teams", {}, null)) as readonly TeamSummary[];
  }

  getPersonalPersonalization(): Promise<PersonalPersonalization> {
    return this.request("/v1/me/personalization", {}, null);
  }

  updatePersonalPersonalization(input: {
    readonly content: string;
    readonly applyToTeamTasks: boolean;
    readonly expectedVersion: number;
  }): Promise<PersonalPersonalization> {
    return this.request(
      "/v1/me/personalization",
      { method: "PUT", body: JSON.stringify(input) },
      null,
    );
  }

  getTeamPersonalization(teamId: string): Promise<TeamPersonalization> {
    return this.request(`/v1/teams/${encodeURIComponent(teamId)}/personalization`, {}, teamId);
  }

  updateTeamPersonalization(
    teamId: string,
    input: { readonly content: string; readonly expectedVersion: number },
  ): Promise<TeamPersonalization> {
    return this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/personalization`,
      { method: "PUT", body: JSON.stringify(input) },
      teamId,
    );
  }

  createTeam(displayName: string): Promise<TeamSummary> {
    return this.request(
      "/v1/teams",
      {
        method: "POST",
        body: JSON.stringify({ displayName }),
      },
      null,
    );
  }

  async listTeamMembers(teamId: string): Promise<readonly TeamMember[]> {
    return asArray(
      await this.request<unknown>(`/v1/teams/${encodeURIComponent(teamId)}/members`, {}, teamId),
    ) as readonly TeamMember[];
  }

  addTeamMember(
    teamId: string,
    userId: string,
    role: "admin" | "member" = "member",
  ): Promise<TeamMember> {
    return this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/members`,
      {
        method: "POST",
        body: JSON.stringify({ userId, role }),
      },
      teamId,
    );
  }

  changeTeamMemberRole(
    teamId: string,
    userId: string,
    role: TeamMember["role"],
  ): Promise<TeamMember> {
    return this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "PATCH", body: JSON.stringify({ role }) },
      teamId,
    );
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.request(
      `/v1/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`,
      { method: "DELETE" },
      teamId,
    );
  }

  async dissolveTeam(teamId: string): Promise<void> {
    await this.request(`/v1/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" }, teamId);
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
    return this.request<HistoryFilePage>(`/v1/me/history-files${suffix}`, {}, tenantId ?? null);
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
      tenantId ?? null,
    );
    const candidate = record(data)?.url;
    if (typeof candidate === "string") return candidate;
    throw new ApiError("历史文件下载地址格式无效", 502, true);
  }

  async listScheduledTasks(): Promise<readonly ScheduledTask[]> {
    return asArray(await this.request<unknown>("/v1/automations")) as readonly ScheduledTask[];
  }

  createScheduledTask(input: CreateScheduledTaskInput): Promise<ScheduledTask> {
    return this.request("/v1/automations", { method: "POST", body: JSON.stringify(input) });
  }

  updateScheduledTask(taskId: string, input: UpdateScheduledTaskInput): Promise<ScheduledTask> {
    return this.request(`/v1/automations/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
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
      Accept: "application/json",
      "Content-Type": "application/octet-stream",
      "Idempotency-Key": idempotencyKey,
      "X-File-Name": encodeURIComponent(file.name),
      "X-File-Media-Type": file.type || "application/octet-stream",
    });
    if (this.accessToken !== undefined) headers.set("Authorization", `Bearer ${this.accessToken}`);
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
    (item.phase === undefined || item.phase === "commentary" || item.phase === "final_answer") &&
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
