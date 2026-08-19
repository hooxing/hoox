import type {
  AdminControlOverviewDto,
  ControlAuditEventDto,
  CreateMemoryProviderDraftRequest,
  CreateModelProviderDraftRequest,
  CreateRuntimeSettingsDraftRequest,
  MemoryProviderRevisionDto,
  ModelProviderRevisionDto,
  ProbeControlRevisionRequest,
  PublishControlRevisionRequest,
  RuntimeSettingsRevisionDto,
} from "@hoox/protocol";
import { AdminApiError } from "./api.js";

interface SuccessEnvelope<T> {
  readonly data: T;
}

interface ListEnvelope<T> {
  readonly items: readonly T[];
}

interface ErrorEnvelope {
  readonly error?: { readonly retryable?: boolean };
}

function messageFor(status: number): string {
  if (status === 400) return "配置内容不符合要求，请检查字段和变更原因。";
  if (status === 401 || status === 403) return "当前账号没有访问控制面的权限。";
  if (status === 404) return "配置版本不存在，请刷新后重试。";
  if (status === 409) return "配置版本已发生变化，请刷新后重试。";
  if (status === 503) return "Provider 探测失败或依赖暂时不可用。";
  return "后台控制服务暂时不可用，请稍后重试。";
}

export class AdminControlApi {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    private readonly baseUrl = "/v1/admin/control",
    private readonly idempotencyKey: () => string = () => crypto.randomUUID(),
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) {
      headers.set("Content-Type", "application/json");
      headers.set("Idempotency-Key", this.idempotencyKey());
    }
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        credentials: "same-origin",
        headers,
      });
    } catch {
      throw new AdminApiError("无法连接后台控制服务。", 0, true);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const failure = body as ErrorEnvelope | undefined;
      throw new AdminApiError(
        messageFor(response.status),
        response.status,
        failure?.error?.retryable ?? response.status >= 500,
      );
    }
    if (typeof body !== "object" || body === null || !("data" in body)) {
      throw new AdminApiError("后台控制服务返回了无法识别的数据。", 502, true);
    }
    return (body as SuccessEnvelope<T>).data;
  }

  overview(): Promise<AdminControlOverviewDto> {
    return this.request("/overview");
  }

  async listModelProviders(): Promise<readonly ModelProviderRevisionDto[]> {
    return (await this.request<ListEnvelope<ModelProviderRevisionDto>>("/model-providers")).items;
  }

  async listMemoryProviders(): Promise<readonly MemoryProviderRevisionDto[]> {
    return (await this.request<ListEnvelope<MemoryProviderRevisionDto>>("/memory-providers")).items;
  }

  async listRuntimeSettings(): Promise<readonly RuntimeSettingsRevisionDto[]> {
    return (await this.request<ListEnvelope<RuntimeSettingsRevisionDto>>("/runtime-settings"))
      .items;
  }

  async listAudits(limit = 50): Promise<readonly ControlAuditEventDto[]> {
    return (await this.request<ListEnvelope<ControlAuditEventDto>>(`/audits?limit=${limit}`)).items;
  }

  createModelDraft(input: CreateModelProviderDraftRequest): Promise<ModelProviderRevisionDto> {
    return this.request("/model-providers", { method: "POST", body: JSON.stringify(input) });
  }

  createMemoryDraft(input: CreateMemoryProviderDraftRequest): Promise<MemoryProviderRevisionDto> {
    return this.request("/memory-providers", { method: "POST", body: JSON.stringify(input) });
  }

  createRuntimeSettingsDraft(
    input: CreateRuntimeSettingsDraftRequest,
  ): Promise<RuntimeSettingsRevisionDto> {
    return this.request("/runtime-settings", { method: "POST", body: JSON.stringify(input) });
  }

  probe(
    kind: "model-providers" | "memory-providers",
    providerKey: string,
    revision: number,
    input: ProbeControlRevisionRequest,
  ): Promise<ModelProviderRevisionDto | MemoryProviderRevisionDto> {
    return this.request(`/${kind}/${encodeURIComponent(providerKey)}/revisions/${revision}/probe`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  publish(
    kind: "model-providers" | "memory-providers" | "runtime-settings",
    providerKey: string,
    revision: number,
    input: PublishControlRevisionRequest,
  ): Promise<ModelProviderRevisionDto | MemoryProviderRevisionDto | RuntimeSettingsRevisionDto> {
    return this.request(
      `/${kind}/${encodeURIComponent(providerKey)}/revisions/${revision}/publish`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }
}

export type AdminControlApiContract = Pick<
  AdminControlApi,
  | "overview"
  | "listModelProviders"
  | "listMemoryProviders"
  | "listRuntimeSettings"
  | "listAudits"
  | "createModelDraft"
  | "createMemoryDraft"
  | "createRuntimeSettingsDraft"
  | "probe"
  | "publish"
>;
