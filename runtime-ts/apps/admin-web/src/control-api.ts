import type {
  AdminControlOverviewDto,
  IdentityAdminConfigurationDto,
  UpdateIdentityAdminConfigurationRequest,
  ControlAuditEventDto,
  CreateMemoryProviderDraftRequest,
  CreateModelProviderDraftRequest,
  CreateRuntimeSettingsDraftRequest,
  MemoryProviderRevisionDto,
  ModelProviderRevisionDto,
  PiModelCatalogModelDto,
  PiModelCatalogProviderDto,
  PlatformUserPageDto,
  PlatformUserSummaryDto,
  ProbeControlRevisionRequest,
  PublishControlRevisionRequest,
  RuntimeSettingsRevisionDto,
  UpdatePlatformUserStatusRequest,
} from "@hoox/protocol";
import { adminAuthorizationHeader } from "./admin-session.js";
import { AdminApiError } from "./api.js";
import {
  findLocalPiModelCatalogModels,
  listLocalPiModelCatalogProviders,
} from "./pi-model-catalog.js";

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
    private readonly authorizationHeader: () => string | undefined = adminAuthorizationHeader,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    const authorizationHeader = this.authorizationHeader();
    if (authorizationHeader !== undefined) headers.set("Authorization", authorizationHeader);
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

  getIdentityConfiguration(): Promise<IdentityAdminConfigurationDto> {
    return this.request("/identity");
  }

  updateIdentityConfiguration(
    input: UpdateIdentityAdminConfigurationRequest,
  ): Promise<IdentityAdminConfigurationDto> {
    return this.request("/identity", { method: "PUT", body: JSON.stringify(input) });
  }

  async listModelProviders(): Promise<readonly ModelProviderRevisionDto[]> {
    return (await this.request<ListEnvelope<ModelProviderRevisionDto>>("/model-providers")).items;
  }

  async listPiModelCatalogProviders(): Promise<readonly PiModelCatalogProviderDto[]> {
    try {
      return (
        await this.request<ListEnvelope<PiModelCatalogProviderDto>>("/model-catalog/providers")
      ).items;
    } catch (reason) {
      if (catalogServiceUnavailable(reason)) return listLocalPiModelCatalogProviders();
      throw reason;
    }
  }

  async findPiModelCatalogModels(input: {
    readonly providerId?: string;
    readonly query?: string;
    readonly limit?: number;
  }): Promise<readonly PiModelCatalogModelDto[]> {
    const query = new URLSearchParams();
    if (input.providerId !== undefined) query.set("providerId", input.providerId);
    if (input.query !== undefined) query.set("query", input.query);
    query.set("limit", String(input.limit ?? 50));
    try {
      return (
        await this.request<ListEnvelope<PiModelCatalogModelDto>>(
          `/model-catalog/models?${query.toString()}`,
        )
      ).items;
    } catch (reason) {
      if (catalogServiceUnavailable(reason)) {
        return findLocalPiModelCatalogModels({
          ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
          ...(input.query === undefined ? {} : { query: input.query }),
          limit: input.limit ?? 50,
        });
      }
      throw reason;
    }
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

  listUsers(
    input: { readonly query?: string; readonly limit?: number } = {},
  ): Promise<PlatformUserPageDto> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.query !== undefined) query.set("query", input.query);
    return this.request(`/users?${query.toString()}`);
  }

  updateUserStatus(
    userId: string,
    input: UpdatePlatformUserStatusRequest,
  ): Promise<PlatformUserSummaryDto> {
    return this.request(`/users/${encodeURIComponent(userId)}/status`, {
      method: "POST",
      body: JSON.stringify(input),
    });
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

function catalogServiceUnavailable(reason: unknown): reason is AdminApiError {
  return (
    reason instanceof AdminApiError &&
    (reason.status === 0 || (reason.status >= 500 && reason.retryable))
  );
}

export type AdminControlApiContract = Pick<
  AdminControlApi,
  | "overview"
  | "getIdentityConfiguration"
  | "updateIdentityConfiguration"
  | "listModelProviders"
  | "listPiModelCatalogProviders"
  | "findPiModelCatalogModels"
  | "listMemoryProviders"
  | "listRuntimeSettings"
  | "listAudits"
  | "listUsers"
  | "updateUserStatus"
  | "createModelDraft"
  | "createMemoryDraft"
  | "createRuntimeSettingsDraft"
  | "probe"
  | "publish"
>;
