import { userId } from "@hoox/domain";
import type { AuthContextResolver } from "@hoox/identity/auth";
import { SkillServiceError } from "@hoox/skill";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerSkillNamespaceRoutes } from "./skill-namespace-routes.js";

const actorId = userId("user_skill_admin");

function fixture() {
  const auth: AuthContextResolver = {
    async resolve({ authorization }) {
      return authorization === "Bearer valid" ? { userId: actorId } : undefined;
    },
  };
  const publications = {
    publicationAccess: vi.fn(async () => ({
      role: "publisher" as const,
      namespaces: ["team-tools"],
    })),
    listNamespaces: vi.fn(async () => []),
    createNamespace: vi.fn(async () => undefined),
    grantNamespace: vi.fn(async () => undefined),
    revokeNamespace: vi.fn(async () => undefined),
  };
  const app = Fastify();
  registerSkillNamespaceRoutes(app, { auth, publications });
  return { app, publications };
}

describe("Skill 命名空间管理路由", () => {
  it("返回发布者权限且命名空间管理写操作由领域服务授权", async () => {
    const { app, publications } = fixture();
    const access = await app.inject({
      method: "GET",
      url: "/v1/admin/control/skill-publication-access",
      headers: { authorization: "Bearer valid" },
    });
    expect(access.statusCode).toBe(200);
    expect(access.json().data).toEqual({ role: "publisher", namespaces: ["team-tools"] });

    const grant = await app.inject({
      method: "POST",
      url: "/v1/admin/control/skill-namespaces/team-tools/publishers",
      headers: { authorization: "Bearer valid" },
      payload: { userId: "user_publisher" },
    });
    expect(grant.statusCode).toBe(200);
    expect(publications.grantNamespace).toHaveBeenCalledWith(
      actorId,
      "team-tools",
      userId("user_publisher"),
    );
    await app.close();
  });

  it("未认证和越权主体不会泄露命名空间资源", async () => {
    const { app, publications } = fixture();
    const missingAuth = await app.inject({
      method: "GET",
      url: "/v1/admin/control/skill-namespaces",
    });
    expect(missingAuth.statusCode).toBe(401);
    publications.listNamespaces.mockRejectedValueOnce(new SkillServiceError("NOT_FOUND", "hidden"));
    const denied = await app.inject({
      method: "GET",
      url: "/v1/admin/control/skill-namespaces",
      headers: { authorization: "Bearer valid" },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.json().error.message).toBe("请求的资源不存在");
    await app.close();
  });
});
