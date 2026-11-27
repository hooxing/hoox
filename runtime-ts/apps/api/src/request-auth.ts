import type { ApiKeyScope } from "@hoox/domain";
import { isExternalEndUserId } from "@hoox/identity";
import type { FastifyRequest } from "fastify";
import { headerValues, requestId } from "./http.js";
import type { TenantSelector } from "./ports.js";
import { ApiFailure, type ApiService, type AuthContext } from "./service.js";

export type AuthenticateRequest = (
  request: FastifyRequest,
  requiredScope?: ApiKeyScope,
) => Promise<AuthContext>;
export type AuthenticateSelectedTenant = (
  request: FastifyRequest,
  selectedTenantId: string,
  requiredScope?: ApiKeyScope,
) => Promise<AuthContext>;

export function createRequestAuthentication(service: Pick<ApiService, "authenticate">): {
  authenticate: AuthenticateRequest;
  authenticateSelectedTenant: AuthenticateSelectedTenant;
} {
  const enforceCredentialBoundary = (
    auth: AuthContext,
    requiredScope?: ApiKeyScope,
  ): AuthContext => {
    if (
      auth.apiKey !== undefined &&
      (requiredScope === undefined || !auth.apiKey.scopes.includes(requiredScope))
    ) {
      throw new ApiFailure("forbidden");
    }
    return auth;
  };
  const authenticate = async (request: FastifyRequest, requiredScope?: ApiKeyScope) =>
    enforceCredentialBoundary(
      await service.authenticate(
        authorization(request),
        requestId(request),
        tenantSelector(request),
        { endUserId: endUserId(request), requiredScope },
      ),
      requiredScope,
    );
  const authenticateSelectedTenant = async (
    request: FastifyRequest,
    selectedTenantId: string,
    requiredScope?: ApiKeyScope,
  ) =>
    enforceCredentialBoundary(
      await service.authenticate(
        authorization(request),
        requestId(request),
        { kind: "selected", value: selectedTenantId },
        { endUserId: endUserId(request), requiredScope },
      ),
      requiredScope,
    );
  return { authenticate, authenticateSelectedTenant };
}

function endUserId(request: FastifyRequest): string | undefined {
  const values = headerValues(request, "hoox-end-user");
  const [value] = values;
  if (values.length > 1 || (value !== undefined && !isExternalEndUserId(value))) {
    throw new ApiFailure("bad_request");
  }
  return value;
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
