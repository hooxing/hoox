import { isoTimestamp } from "@hoox/domain";
import type {
  LocalAccountPasswordRecord,
  LocalAccountProfileRecord,
  LocalAccountRepository,
  RegisterLocalAccountInput,
} from "@hoox/persistence";
import { describe, expect, it } from "vitest";
import { createLocalAccountAuthService } from "./local-account-auth.js";
import { ApiFailure } from "./service.js";

class MemoryLocalAccounts implements LocalAccountRepository {
  readonly accounts = new Map<string, LocalAccountPasswordRecord>();
  readonly sessions = new Map<string, { profile: LocalAccountProfileRecord; expiresAt: string }>();

  async register(input: RegisterLocalAccountInput): Promise<"created" | "conflict"> {
    if (this.accounts.has(input.email)) return "conflict";
    const account: LocalAccountPasswordRecord = {
      userId: input.userId,
      personalTenantId: input.personalTenantId,
      email: input.email,
      displayName: input.displayName,
      passwordAlgorithm: input.passwordAlgorithm,
      passwordSalt: input.passwordSalt,
      passwordHash: input.passwordHash,
    };
    this.accounts.set(input.email, account);
    this.sessions.set(input.sessionTokenDigest, {
      profile: account,
      expiresAt: input.sessionExpiresAt,
    });
    return "created";
  }

  async findByNormalizedEmail(email: string): Promise<LocalAccountPasswordRecord | undefined> {
    return this.accounts.get(email);
  }

  async createSession(input: {
    readonly tokenDigest: string;
    readonly userId: string;
    readonly personalTenantId: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  }): Promise<void> {
    const account = Array.from(this.accounts.values()).find((item) => item.userId === input.userId);
    if (account === undefined) throw new Error("ACCOUNT_NOT_FOUND");
    this.sessions.set(input.tokenDigest, { profile: account, expiresAt: input.expiresAt });
  }

  async resolveSession(
    tokenDigest: string,
    now: string,
  ): Promise<LocalAccountProfileRecord | undefined> {
    const session = this.sessions.get(tokenDigest);
    return session !== undefined && session.expiresAt > now ? session.profile : undefined;
  }

  async findProfileByUserId(
    userId: string,
    personalTenantId: string,
  ): Promise<LocalAccountProfileRecord | undefined> {
    return Array.from(this.accounts.values()).find(
      (item) => item.userId === userId && item.personalTenantId === personalTenantId,
    );
  }

  async revokeSession(tokenDigest: string): Promise<void> {
    this.sessions.delete(tokenDigest);
  }
}

const clock = Object.freeze({ now: () => isoTimestamp("2026-08-16T08:00:00.000Z") });

function expectFailureKind(reason: unknown, kind: ApiFailure["kind"]): void {
  expect(reason).toBeInstanceOf(ApiFailure);
  expect((reason as ApiFailure).kind).toBe(kind);
}

describe("本地账号认证服务", () => {
  it("注册时创建独立个人身份，并可用返回的会话解析 principal", async () => {
    const repository = new MemoryLocalAccounts();
    const service = createLocalAccountAuthService({ repository, clock });
    const session = await service.register({
      displayName: "林晓",
      email: " LIN@Example.com ",
      password: "secret12",
    });

    expect(session.profile.email).toBe("lin@example.com");
    expect(session.profile.id).toMatch(/^user_/u);
    expect(session.accessToken).toMatch(/^hoox_session_/u);
    await expect(
      service.resolve({ authorization: `Bearer ${session.accessToken}`, requestId: "request-1" }),
    ).resolves.toMatchObject({
      userId: session.profile.id,
      tenantId: expect.stringMatching(/^tenant_personal_/u),
    });
  });

  it("同一邮箱不能重复注册，密码错误也不会签发会话", async () => {
    const repository = new MemoryLocalAccounts();
    const service = createLocalAccountAuthService({ repository, clock });
    await service.register({ displayName: "林晓", email: "lin@example.com", password: "secret12" });

    await service
      .register({ displayName: "另一用户", email: "LIN@example.com", password: "another12" })
      .then(() => {
        throw new Error("EXPECTED_CONFLICT");
      })
      .catch((reason: unknown) => expectFailureKind(reason, "conflict"));
    await service
      .login({ email: "lin@example.com", password: "incorrect" })
      .then(() => {
        throw new Error("EXPECTED_UNAUTHORIZED");
      })
      .catch((reason: unknown) => expectFailureKind(reason, "unauthorized"));
  });

  it("登录签发新会话，退出后该令牌不再可解析", async () => {
    const repository = new MemoryLocalAccounts();
    const service = createLocalAccountAuthService({ repository, clock });
    await service.register({ displayName: "林晓", email: "lin@example.com", password: "secret12" });
    const session = await service.login({ email: "lin@example.com", password: "secret12" });
    const authorization = `Bearer ${session.accessToken}`;

    await expect(service.resolve({ authorization, requestId: "before" })).resolves.toBeDefined();
    await service.logout(authorization);
    await expect(service.resolve({ authorization, requestId: "after" })).resolves.toBeUndefined();
  });
});
