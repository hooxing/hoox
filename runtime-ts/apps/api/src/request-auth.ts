import type { FastifyRequest } from "fastify";
import { headerValues, requestId } from "./http.js";
import type { TenantSelector } from "./ports.js";
import { ApiFailure, type ApiService, type AuthContext } from "./service.js";

export type AuthenticateRequest = (request: FastifyRequest) => Promise<AuthContext>;
export type AuthenticateSelectedTenant = (
  request: FastifyRequest,
  selectedTenantId: string,
) => Promise<AuthContext>;

export function createRequestAuthentication(service: Pick<ApiService, "authenticate">): {
  authenticate: AuthenticateRequest;
  authenticateSelectedTenant: AuthenticateSelectedTenant;
} {
  const authenticate = async (request: FastifyRequest) =>
    service.authenticate(authorization(request), requestId(request), tenantSelector(request));
  const authenticateSelectedTenant = async (request: FastifyRequest, selectedTenantId: string) =>
    service.authenticate(authorization(request), requestId(request), {
      kind: "selected",
      value: selectedTenantId,
    });
  return { authenticate, authenticateSelectedTenant };
}

export function authorization(request: FastifyRequest): string | undefined {
  const values = headerValues(request, "authorization");
  return values.length === 1 ? values[0] : undefined;
}

function tenantSelector(request: FastifyRequest): TenantSelector {
  const values = headerValues(request, "x-tenant-id");
  if (values.length === 0) return Object.freeze({ kind: "absent" });
  if (values.length !== 1 || values[0] === undefined) return Object.freeze({ kind: "invalid" });
  return Object.freeze({ kind: "selected", value: values[0] });
}

export function requireTeamScope(
  auth: Readonly<{
    scope: Readonly<{ tenantId: string }>;
    tenant: Readonly<{ tenant: Readonly<{ kind: "personal" | "team" }> }>;
  }>,
  teamId: string,
): void {
  if (auth.tenant.tenant.kind !== "team" || auth.scope.tenantId !== teamId) {
    throw new ApiFailure("not_found");
  }
}
