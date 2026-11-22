import type {
  ApiKeyDto,
  CreateApiKeyRequest,
  CreateWebhookRequest,
  TenantWebhookDto,
} from "@hoox/protocol";
import { adminAuthorizationHeader } from "./admin-session.js";
import { AdminApiError } from "./api.js";

export class IntegrationApi {
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async listTenants() {
    const headers = new Headers({ Accept: "application/json" });
    const authorization = adminAuthorizationHeader();
    if (authorization !== undefined) headers.set("Authorization", authorization);
    const response = await this.fetcher("/v1/admin/control/integrations/tenants", {
      method: "GET",
      headers,
      credentials: "same-origin",
      cache: "no-store",
    }).catch(() => {
      throw new AdminApiError("无法读取 Tenant 列表。", 0, true);
    });
    if (!response.ok)
      throw new AdminApiError(
        "仅平台管理员可读取 Tenant 列表。",
        response.status,
        response.status >= 500,
      );
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || !("data" in body))
      throw new AdminApiError("后台控制服务返回了无法识别的数据。", 502, true);
    return (body as { data: { items: readonly IntegrationTenantDto[] } }).data.items;
  }

  private async request<T>(
    tenant: string,
    path: string,
    method = "GET",
    input?: unknown,
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    const authorization = adminAuthorizationHeader();
    if (authorization !== undefined) headers.set("Authorization", authorization);
    if (input !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetcher(
        `/v1/admin/control/integrations/${encodeURIComponent(tenant)}${path}`,
        {
          method,
          headers,
          credentials: "same-origin",
          cache: "no-store",
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
      );
    } catch {
      throw new AdminApiError("无法确认操作结果，请刷新列表核对，不要重复提交。", 0, true);
    }
    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "仅平台管理员可管理接入配置。"
          : response.status === 404
            ? "Tenant 或接入配置不存在。"
            : response.status === 400
              ? "配置不符合要求，请检查作用域、到期时间和公网 HTTPS 地址。"
              : "无法确认操作结果，请刷新列表核对，不要重复提交。";
      throw new AdminApiError(message, response.status, response.status >= 500);
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (typeof body !== "object" || body === null || !("data" in body)) {
      throw new AdminApiError("无法确认操作结果，请刷新列表核对，不要重复提交。", 502, true);
    }
    return (body as { data: T }).data;
  }

  async listKeys(tenant: string) {
    return (await this.request<{ items: ApiKeyDto[] }>(tenant, "/api-keys")).items;
  }
  createKey(tenant: string, input: CreateApiKeyRequest) {
    return this.request<{ key: ApiKeyDto; token: string }>(tenant, "/api-keys", "POST", input);
  }
  rotateKey(tenant: string, id: string) {
    return this.request<{ key: ApiKeyDto; token: string }>(
      tenant,
      `/api-keys/${encodeURIComponent(id)}/rotate`,
      "POST",
    );
  }
  revokeKey(tenant: string, id: string) {
    return this.request<ApiKeyDto>(tenant, `/api-keys/${encodeURIComponent(id)}`, "DELETE");
  }
  async listWebhooks(tenant: string) {
    return (await this.request<{ items: TenantWebhookDto[] }>(tenant, "/webhooks")).items;
  }
  createWebhook(tenant: string, input: CreateWebhookRequest) {
    return this.request<{ webhook: TenantWebhookDto; secret: string }>(
      tenant,
      "/webhooks",
      "POST",
      input,
    );
  }
  rotateWebhook(tenant: string, id: string) {
    return this.request<{ secret: string }>(
      tenant,
      `/webhooks/${encodeURIComponent(id)}/rotate-secret`,
      "POST",
    );
  }
  disableWebhook(tenant: string, id: string) {
    return this.request<{ webhook: TenantWebhookDto }>(
      tenant,
      `/webhooks/${encodeURIComponent(id)}/disable`,
      "POST",
    );
  }
  removeWebhook(tenant: string, id: string) {
    return this.request<{ deleted: boolean }>(
      tenant,
      `/webhooks/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }
}

export interface IntegrationTenantDto {
  readonly tenantId: string;
  readonly displayName: string;
  readonly kind: "personal" | "team";
  readonly isDefault: boolean;
}

export const integrationApi = new IntegrationApi();
