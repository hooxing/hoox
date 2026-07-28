export type Thread = {
  readonly id: string;
  readonly title: string;
  readonly status: "active" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RunStatus = "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
export type Run = {
  readonly id: string;
  readonly threadId: string;
  readonly status: RunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type RunEvent = {
  readonly eventId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly type: string;
  readonly payload: unknown;
};

export type Artifact = {
  readonly id: string;
  readonly name: string;
  readonly status: "publishing" | "published" | "failed";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly mediaType?: string;
  readonly sizeBytes?: number;
};

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

export class RuntimeApi {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly baseUrl = "/api",
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", "Bearer dev-user-a");
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (init.method === "POST") headers.set("Idempotency-Key", createKey());
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

  async listThreads(): Promise<readonly Thread[]> {
    return asArray(await this.request<unknown>("/v1/threads?limit=100")) as readonly Thread[];
  }
  createThread(title: string): Promise<Thread> {
    return this.request("/v1/threads", { method: "POST", body: JSON.stringify({ title }) });
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
  async listEvents(threadId: string, runId: string, after = -1): Promise<readonly RunEvent[]> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/events?after=${after}&limit=100`,
    );
    return asArray(data) as readonly RunEvent[];
  }
  async listArtifacts(threadId: string, runId: string): Promise<readonly Artifact[]> {
    const data = await this.request<unknown>(
      `/v1/threads/${encodeURIComponent(threadId)}/runs/${encodeURIComponent(runId)}/artifacts`,
    );
    return asArray(data) as readonly Artifact[];
  }
  async downloadArtifact(artifactId: string): Promise<string> {
    const data = await this.request<unknown>(
      `/v1/artifacts/${encodeURIComponent(artifactId)}/download`,
      {
        method: "POST",
        body: "{}",
      },
    );
    if (typeof data === "object" && data !== null) {
      const candidate =
        (data as { readonly url?: unknown; readonly downloadUrl?: unknown }).url ??
        (data as { readonly downloadUrl?: unknown }).downloadUrl;
      if (typeof candidate === "string") return candidate;
    }
    throw new ApiError("下载地址格式无效", 502, true);
  }
}
